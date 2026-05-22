# Beam — Technical Spec

> Display name: **Beam**. Repo / CLI / package namespace: `routr`.
>
> This document is the source of truth for what Beam is and how it works.
> It is written for the implementer (me). It will be updated as decisions
> change. Marketing copy lives in README.md, not here.

## 1. Product summary

Beam is an open-source, self-hostable replacement for PushBullet. It lets a
user send URLs and files between their own devices (phone, tablet, laptop,
desktop, browser) using each platform's native share affordance, and
optionally share with other users — including users on a different Beam
server.

Server is a "dumb pipe": end-to-end encrypted, never sees plaintext message
bodies or file contents.

## 2. Core feature set (v1)

1. **Share** a URL or small file from any device → any other device on the
   account, using the native Share Sheet / Intent / etc.
2. **Receive** messages on any device. Native notification + in-app inbox.
3. **Routing rules** (client-side): "URLs matching `*.youtube.com` go to my
   Firefox-on-laptop", "files > 5MB go to my desktop", etc. Rules sync
   across the user's devices as encrypted state.
4. **Inbox / history** viewable on any device that has a key, including
   the web app. Server stores ciphertext only.
5. **Queueing**: if the target device is offline, the encrypted message
   sits on the server until the device comes online or a TTL expires.
6. **Device pairing**: add a new device by scanning a QR / pasting a code,
   Syncthing-style. No central account registry required.
7. **Multi-user on one server**: a server admin can host multiple users.
   Users share with each other by exchanging peer invites.
8. **Cross-server peering (v2)**: same peer-invite flow works across
   servers. Deferred from the initial release.

## 3. Non-goals (v1)

- Real-time chat / replies (Beam is one-shot share, not messaging).
- Audio/video calling.
- Group chats.
- Server-side smart routing (rules run on the client because the server
  can't read content).
- ActivityPub / fediverse federation (we use a simpler model — see §7).
- Discoverability (no global user directory).
- iOS / Android / Firefox / Safari / desktop apps in v1 (planned but not
  in the first slice).

## 4. Tech stack

**Why TypeScript everywhere:** one language across server, web,
extension, eventual desktop (Electron/Tauri) and mobile (React Native /
Capacitor). Maximum code reuse on the crypto and protocol layers, which
is where bugs are scariest.

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Industry standard, fast, simple |
| Language | TypeScript (strict) | Shared types end-to-end |
| Server runtime | Node.js 22 LTS | Stable, broadly available, easy self-hosting |
| Server framework | Hono | Fast, tiny, first-class WebSocket support, runs on Node/Bun/Deno/Cloudflare |
| Server storage | SQLite (default) via Drizzle ORM | Zero-config self-host. Postgres pluggable later |
| Server auth | WebAuthn / passkeys (primary), invite tokens for first-device | Phishing-resistant, no password reset hell |
| Web app | Vite + React 19 + TanStack Router + TanStack Query | Fast dev loop, type-safe routing |
| Styling | Tailwind v4 + shadcn/ui | Fast, accessible, easy to theme |
| Chrome extension | WXT + React | Modern MV3 framework, same React components as web app |
| Crypto | @noble/curves + @noble/ciphers + @noble/hashes | Audited, pure-JS, works in browser/Node/extension/RN |
| Testing | Vitest (unit), Playwright (e2e) | Standard, fast |
| Lint/format | Biome | One tool for both, fast |
| CI | GitHub Actions | Free for OSS |
| Container | Distroless multi-arch Docker image | The primary self-host distribution |
| License | AGPL-3.0 | Strong copyleft for a server product. Prevents closed-source SaaS forks. |

## 5. Repo layout

```
/
├── apps/
│   ├── server/              Node + Hono server
│   ├── web/                 React web app (PWA-capable)
│   └── extension-chrome/    WXT-based MV3 extension
├── packages/
│   ├── protocol/            Wire-format types, message schemas, version constants
│   ├── crypto/              E2EE primitives, key management, sealed-sender
│   ├── client-core/         Transport-agnostic client (WS, REST, queueing, retries)
│   └── ui/                  Shared React components + Tailwind preset
├── docs/                    Architecture deep-dives, ADRs
├── SPEC.md                  This file
├── PLAN.md                  Living work plan + status
└── README.md                Public-facing overview
```

## 6. Cryptography

### 6.1 Key material per device

Every device generates, on first launch, a long-term **identity keypair**:

- **Signing key**: Ed25519. Used to sign outgoing messages and to sign
  trust attestations of other devices.
- **Key-exchange key**: X25519. Used for ECDH to derive per-message
  encryption keys.

Private keys never leave the device. Public keys are uploaded to the
server.

### 6.2 Device trust within a user's account

A user's account is a set of devices that have mutually signed each
other's identity public keys. The first device is the **root** for the
user. New devices are added by:

1. New device generates keypair, displays its public key as a QR code
   (and a short numeric code for fallback).
2. An existing trusted device scans/enters it, displays a confirmation
   prompt, then signs the new device's public key and uploads the
   signature.
3. New device fetches the signature from server, verifies, then trusts
   the existing device's public keys (which were included in the QR
   payload).

Both devices end up cross-signed. Server never sees private material.

### 6.3 Message encryption

Per message to N recipient devices:

1. Sender generates a fresh symmetric key `K` (32 bytes, ChaCha20-Poly1305).
2. Sender encrypts the payload with `K`.
3. For each recipient device D, sender derives a shared secret via X25519
   between sender's ephemeral keypair and D's public key, then wraps `K`
   under that shared secret using HKDF + ChaCha20-Poly1305.
4. Sender signs the message metadata + ciphertext hash with their Ed25519
   key.
5. The server receives: ephemeral pubkey, N wrapped keys keyed by
   recipient device ID, ciphertext, signature. It cannot decrypt.

This is sealed-sender-ish but we keep the sender device ID visible to
the server — needed for queueing and routing — and only encrypt the
content. v2 may move to fully anonymous sealed sender.

### 6.4 File encryption

Files use the same scheme but the ciphertext is streamed/chunked and
uploaded to the server's blob store. The message envelope contains the
blob URL + integrity hash. Server stores ciphertext, deletes after all
recipients ack or TTL expires.

Chunk size: 1 MiB. Per-chunk authentication tag. Resumable uploads via
HTTP range PUTs.

### 6.5 Threat model

- **Adversary: server operator (self-hosted by someone else).** Can see
  metadata (who sent what to whom, when, sizes). Cannot read message
  bodies or files.
- **Adversary: network observer.** TLS everywhere. Cannot see anything
  the server can't already see.
- **Adversary: device theft.** Out of scope for v1 — private keys live
  in localStorage/IndexedDB/keychain. v2: optional passphrase-encrypted
  keystore.
- **Adversary: malicious extension / web app.** Trusted by definition;
  we ship them.

## 7. Federation (peer-invite model)

Phase 1 (single server): users on the same server exchange a peer code
to allow sharing.

Phase 2 (cross-server): a user on Server A and a user on Server B
exchange a code that encodes `(server_url, user_identity_pubkey,
one_time_token)`. Server A is configured to deliver to Server B by POSTing
to Server B's well-known inbox endpoint, signed with the originating
user's key. Server B verifies the user pubkey is on its allowlist and
delivers to the recipient's devices.

No global discovery, no shared directory. Two servers only know about
each other if a user on one explicitly invited a user on the other.

## 8. Wire protocol (high level)

### 8.1 Transport

- **REST/JSON over HTTPS** for registration, key upload, blob upload,
  inbox listing, ack.
- **WebSocket** for real-time push to online devices. One persistent
  connection per device. Server pushes new messages as they arrive.

### 8.2 Message envelope (server-visible)

```ts
type Envelope = {
  id: string;              // ULID, server-assigned
  from_device: string;     // device ID
  to_devices: string[];    // device IDs
  created_at: number;      // unix ms
  expires_at: number;      // unix ms
  kind: "url" | "file" | "control";
  size_bytes: number;
  ciphertext_ref: string;  // inline ≤ 4KB or blob:<id> for files
  wrapped_keys: { [device_id: string]: string };  // base64
  sender_ephemeral_pubkey: string;
  signature: string;       // sender's Ed25519 sig over the canonical envelope
};
```

### 8.3 Client decrypted payload

```ts
type Payload =
  | { kind: "url"; url: string; title?: string; note?: string }
  | { kind: "file"; filename: string; mime: string; blob: ArrayBuffer }
  | { kind: "control"; op: "rule_sync" | "device_added" | ...; data: ... };
```

## 9. Routing rules

Rules are client-side, evaluated on the **sender** device at share time:

```ts
type Rule = {
  id: string;
  match: { kind: "url"; url_pattern: string } | { kind: "file"; mime_glob?: string; min_bytes?: number };
  action: { kind: "send_to"; device_ids: string[] };
  priority: number;
};
```

Rules sync as encrypted control messages to all of the user's devices,
so any device can edit them and the rest learn within seconds.

Default behavior when no rule matches: prompt the user with the share
sheet to pick destination(s). The chosen destination is remembered as a
suggested rule.

## 10. Server data model (SQLite)

```
users           (id, display_name, created_at, ...)
devices         (id, user_id, name, platform, identity_pubkey_ed, identity_pubkey_x, created_at, last_seen)
device_trusts   (signer_device_id, signed_device_id, signature, created_at)
envelopes       (id, from_device, created_at, expires_at, kind, ciphertext, ...)
recipients      (envelope_id, device_id, wrapped_key, acked_at NULL)
blobs           (id, envelope_id, size, sha256, uploaded_at, deleted_at NULL)
peers           (user_id, peer_user_id, peer_server, peer_pubkey, created_at)
auth_credentials (user_id, type, credential_id, public_key, ...)   -- WebAuthn
invite_tokens   (token, user_id, scope, expires_at, used_at)
```

Server-side retention: an envelope is deleted once all of its recipients
have acked it (or it expires). Blobs deleted with their envelope.

## 11. MVP scope (first releasable slice)

1. **Server**: register user, register device, WebSocket inbox, REST
   upload, basic blob storage on local disk.
2. **Web app**: pair this browser as a device (first device = create
   account; subsequent = scan QR from existing device), inbox view, send
   form (paste URL → pick recipient), receive notifications.
3. **Chrome extension**: pair as a device, "Share this page" toolbar
   button + right-click context menu, receive notifications.

That's the v1.0 ship target. Mobile, desktop, Firefox, Safari, federation,
routing rules engine, blob storage backends — all v1.1+.

## 12. Coding standards

- TypeScript strict mode, no `any` except at FFI boundaries (and
  documented).
- All cross-package types live in `packages/protocol`. No duplicating
  message shapes.
- Tests: every crypto function has a test vector. Every server endpoint
  has at least one integration test.
- No emojis in code or commits unless explicitly part of UI copy.
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:` etc.).
- Public APIs documented with JSDoc.

## 13. Open questions (to revisit, not blockers)

- Do we want server-side full-text search of message titles? Would
  require leaking title plaintext or building encrypted search.
  Probably skip.
- Push notifications on iOS/Android — these require platform push
  services (APNs/FCM) which can't be E2EE. Plan: send a content-less
  "you have a message" wakeup; the device fetches and decrypts.
- Do we ship a hosted "beam.example.com" instance? Out of scope for now.
- Trust-on-first-use for cross-server delivery: do we require a manual
  user confirmation the first time we see a new peer server, or auto-trust
  on valid signature?
