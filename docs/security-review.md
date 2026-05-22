# Beam — Crypto & Protocol Security Review (M4.3)

This is an internal first-pass review of the v1 cryptographic and
protocol code paths in `packages/crypto`, `packages/protocol`, and the
server's `auth.ts` / `envelopes.ts`. The goal is to surface known
limitations and confirm the primitives are wired up correctly, not to
substitute for an external audit before we declare the protocol stable.

Scope reviewed:

- `packages/crypto/src/{keys,sign,seal,base64url}.ts`
- `packages/protocol/src/canonical.ts`
- `apps/server/src/auth.ts`
- `apps/server/src/services/envelopes.ts`
- `apps/server/src/ws/session.ts`

## Primitives

| Use | Algorithm | Library |
|---|---|---|
| Device identity (signing) | Ed25519 | `@noble/curves` |
| Device identity (key agreement) | X25519 | `@noble/curves` |
| Per-envelope payload encryption | ChaCha20-Poly1305 | `@noble/ciphers` |
| Per-recipient key wrap | ECDH(X25519) → HKDF-SHA256 → ChaCha20-Poly1305 | `@noble/*` |
| Random bytes | `crypto.getRandomValues` (browser) / `crypto.randomBytes` (Node) | `@noble/hashes/utils` |

All primitives are from `@noble/*`, which is widely audited and
constant-time. No hand-rolled crypto; no native bindings.

## Strengths

1. **Domain separation in HKDF** — `wrapKey` derives the wrap key with
   `info = "routr.wrap.v1:" + recipientDeviceId`. This binds the wrapped
   key to a specific recipient: if an attacker takes Alice's wrapped key
   and re-files it under Bob's slot in `wrappedKeys`, Bob's unwrap
   derives a different key and the AEAD tag fails. (`seal.ts:78-84`)
2. **Versioned envelope** — Envelopes carry `v: PROTOCOL_VERSION`, and
   HKDF info / WS auth message strings include `v1`. Future protocol
   changes can run side-by-side.
3. **AEAD everywhere** — ChaCha20-Poly1305 for both payload and key
   wrap. Tag verification rejects any tampering of ciphertext or AD.
4. **Constant-time verification** — Ed25519 verify and ChaCha20-Poly1305
   tag check are constant-time in `@noble/*`. No timing oracle.
5. **Signature is over canonical form** — `envelopeSignedForm`
   deterministically serializes with sorted keys, so the wire bytes
   round-trip through JSON.parse + canonicalize identically. Both the
   client and server use the same `canonicalize` helper.
6. **No body-stream consumption pitfall** — `auth.ts` calls
   `c.req.raw.clone().arrayBuffer()` to compute the signed body hash,
   leaving the original stream available for the route handler.
7. **WS challenge nonce is 32 bytes from CSPRNG** — Sufficient to prevent
   accidental collisions and replay-against-different-session.
8. **Random nonce on payload encryption** — `encryptPayload` uses a
   fresh 12-byte random nonce per envelope. Even though the payload key
   is also fresh, the random nonce hardens against future bugs that
   reuse keys.
9. **Fixed zero nonce on key wrap is safe** — Each wrap key is derived
   from a per-envelope ephemeral X25519 keypair × recipient device pub.
   A new ephemeral keypair is generated per envelope, so the wrap key
   is unique per (envelope, recipient). Reusing a constant nonce under
   a key that itself never repeats is safe. (`seal.ts:30`)
10. **No fallback / downgrade paths** — There is only one cipher suite
    in v1. No negotiation, no downgrade attacks.

## Limitations (known, accepted for v1)

### L1: No forward secrecy on stored envelopes

If an attacker eventually compromises a device's `kexSecretKey`, they
can retroactively decrypt every envelope ever sent to that device, as
long as they also captured the ciphertext + the corresponding
ephemeral public key (both of which the server stores).

Mitigation later: Double Ratchet or one-time prekeys. For v1 we accept
this in exchange for protocol simplicity — same trade-off as Signal's
"sealed sender" without the X3DH layer.

### L2: Replay window on signed REST requests — FIXED

~~`auth.ts` accepts a signed request if `|now - timestamp| <= 5 min` and
the Ed25519 signature is valid. There is no per-request nonce stored
server-side.~~

**Resolved**: `apps/server/src/nonce-store.ts` tracks
`(deviceId, timestamp)` pairs in-process for the duration of the clock-
skew window. `requireDeviceAuth` checks the store and rejects duplicates
with `{ok: false, reason: 'replay'}` (HTTP 401). The store auto-evicts
entries past the TTL on each insert.

Limitation: single-process only. A fleet deployment needs a shared
store (redis SETEX, postgres on-conflict). That's tracked in the
parking lot.

### L3: Envelope replay (different concern from L2) — FIXED

~~Envelopes are signed by the sender; the server doesn't enforce that an
envelope is sent only once.~~

**Resolved in commit d6b4b03**: `envelopes.signature` has a UNIQUE index
(migration `0001_previous_otto_octavius.sql`). `submitEnvelope` catches
the unique-violation and returns `{ ok: false, reason: 'duplicate' }`
(HTTP 409). Byte-identical replays are now rejected.

Limitation: this defends against verbatim replay. A sender who wants to
deliver the same payload twice can — they sign a new envelope with a
new `senderEphemeralPub` and the same plaintext. That's expected; the
fix is about replay attacks, not deduplication semantics.

### L4: Metadata exposure to the server

The server sees: sender device ID, recipient device IDs, kind
(url/file/control), size, createdAt, expiresAt, both signatures
(envelope sig + wrapping ephemeral pub key). It cannot read content,
but it can build a social graph.

This is by design — the server needs to route — and acceptable for v1.
Future mitigation: sealed-sender (anonymous to the server) or onion
routing layer; out of scope for MVP.

### L5: HKDF salt is public

In `wrapKey`, the HKDF salt is `ephemeralPublic`. This is fine — HKDF
does not require a secret salt; its security comes from the input key
material (the X25519 shared secret). Using the ephemeral public key as
salt does add domain separation between envelopes, which is the
intended effect. Worth flagging because it differs from naive
"long random salt" intuition.

### L6: No protection against compromised server

A malicious server can:
- Drop or delay envelopes (denial of service).
- Lie to a device about what other devices exist (`GET /devices`),
  enabling man-in-the-middle on first pairing if no out-of-band
  verification.
- Issue invite tokens.

What a malicious server CANNOT do:
- Read message contents.
- Forge envelopes (would need a device's Ed25519 secret).
- Decrypt past traffic without compromising a device.

Mitigation for the pairing-MITM concern (M2.5 follow-up): show device
key fingerprints in the UI for manual verification across a side
channel.

## Code-level notes

- `seal.ts:71` — `decryptPayload` checks `blob.length < 12 + 16` before
  slicing. Good — prevents subtle bugs on malformed input.
- `sign.ts:22` — `verify` catches and returns false instead of
  throwing. Good for use in conditional flow (we never want a thrown
  exception from invalid input to be interpreted as a valid signature).
- `canonical.ts` — Rejects `undefined`, `NaN`, `Infinity`, `function`,
  `symbol`, `bigint`. A signer cannot accidentally produce a canonical
  form that decoders later interpret differently.
- `base64url.ts` — Uses `btoa`/`atob`. Correct for byte arrays because
  we feed bytes via `String.fromCharCode`. Would be incorrect for
  Unicode strings but we never call it on those.
- `envelopes.ts:46-51` — Server checks that `wrappedKeys` keys equal
  `to` array (sorted). Prevents an envelope with mismatched recipient
  metadata from being accepted.

## Known TODOs before declaring v1 stable

1. Wire **fingerprint verification** into the device pairing flow
   (show short fingerprint + QR for out-of-band confirm).
2. ~~Add a **nonce store** for signed-request replay defense~~ — done
   for single-process; multi-process needs redis or similar.
3. ~~Enforce **envelope signature uniqueness** in the DB~~ — done.
4. Add **rate limiting** on `/api/v1/devices` and `/api/v1/invites` to
   prevent enumeration/abuse.
5. Add a **revocation channel** — a signed message a device can issue
   declaring another device of the same user revoked. Currently a
   compromised device can't be cleanly excluded.

These items are tracked in the parking lot section of `PLAN.md`.

## Verdict

No critical findings. All identified issues are either:
- Documented limitations of the chosen protocol (L1, L4),
- Known bounded-impact issues with planned mitigations (L2, L3, L6), or
- Code-level patterns that are already conventional / correct (L5).

The crypto code is conservative: standard primitives, well-audited
libraries, no clever tricks. Recommend an external audit before any
production deployment that handles sensitive content beyond the
MVP self-host case.
