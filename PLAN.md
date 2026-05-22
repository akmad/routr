# Beam — Work Plan

> Living document. I update this every session. Most recent entries first
> within each section. See SPEC.md for the product/architecture spec.

## How to read this file

- **Now** = what I'm actively working on this session.
- **Next** = the immediately following work I've already scoped.
- **Backlog** = scoped but not started.
- **Done** = completed and merged to main.
- **Parking lot** = ideas / questions to revisit later.

Each work item should be small enough that a single PR can ship it.
Bigger features are broken into items here before being started.

---

## Now

_All MVP milestones (M0–M4) complete. Working through follow-ups
from the M4.3 security review and the parking lot below._

## Next

- [ ] Bring the Chrome extension to feature parity with web (rules,
  fingerprint display, file send).
- [ ] Server-side envelope signature uniqueness index (L3 from
  security review).
- [ ] Server-side nonce store for signed-request replay defense (L2).

## Backlog (scoped, not started)

_(empty — see Parking lot for next priorities)_

### Milestone 3 — Chrome extension

- [ ] **M3.1** `apps/extension-chrome` bootstrap: WXT + React, MV3.
- [ ] **M3.2** First-run pairing flow: show QR scanner / paste pairing
  code; receive keys from existing device.
- [ ] **M3.3** Toolbar action: "Send this tab" → encrypt URL → POST to
  server.
- [ ] **M3.4** Context menu: "Send link to Beam" on right-click of a
  link.
- [ ] **M3.5** Background service worker: WS connection to server,
  notification on incoming message.
- [ ] **M3.6** Web Store packaging metadata (icons, screenshots,
  manifest description). Not actually publishing in MVP.

### Milestone 4 — Polish for v1.0 release

- [ ] **M4.1** End-to-end Playwright test: web sends URL → extension
  receives → reverse direction.
- [ ] **M4.2** Self-host docs in README (Docker, reverse proxy, HTTPS).
- [ ] **M4.3** Security review pass on crypto code paths.

## Parking lot

- Push notifications on iOS/Android (need APNs/FCM, content-less wake)
- Routing rules UI + engine (decoupled from MVP — sends always prompt
  for recipient until then)
- Native desktop (Tauri) for system tray + native share extension
- Firefox + Safari extensions (largely the same code as Chrome)
- React Native mobile apps
- Cross-server federation (peer-invite delivery)
- Passphrase-encrypted keystore in browser
- Encrypted search over message titles
- Hosted demo instance

### Security follow-ups from M4.3 review
- Device key fingerprint UI for out-of-band pairing verification
- Server-side nonce store to close the 5-min signed-request replay window
- Unique index on `envelopes.signature` for sender-side replay defense
- Rate limiting on `/api/v1/devices` and `/api/v1/invites`
- Device revocation channel (signed "I no longer trust device X" message)
- Forward secrecy via Double Ratchet or one-time prekeys

## Done

- **Routing rules (client-side)**: `/rules` page in web app with 5 pattern
  types (url_contains, url_regex, mime_prefix, file_ext, kind). IndexedDB
  storage, send-page auto-suggest. 11 matcher tests in vitest. The product
  differentiator vs. PushBullet — rules never see the server.
- **Per-IP rate limiting** on `/api/v1/devices` (10 burst, 1/5s refill)
  and `/api/v1/envelopes` (60 burst, 1/s refill). 2 rate-limit tests.
- **Device fingerprint UI**: `fingerprint(signPub, kexPub)` in @routr/crypto
  (SHA-256 truncated to 16 bytes, formatted as 8 hex groups). Shown on
  Settings + Devices pages for out-of-band MITM verification. 6 tests.
- **File send + receive** (web): URL/File toggle on Send page, client
  encrypts file → uploads as blob → sends envelope with `{blobId, fileKey,
  …}` payload. Recipient downloads blob, decrypts, triggers browser save.
  Adds `fileKey` to FilePayloadSchema.
- **M4.3** Security review pass on crypto code paths. No critical findings;
  6 documented limitations with mitigation paths. See `docs/security-review.md`.
- **M4.2** Self-host docs in README (Docker, nginx/Caddy reverse proxy, env vars, first-run pairing).
- **M4.1** Playwright E2E API test: full register → send → ack round-trip over HTTP.
- **M1.8** Blob storage: POST/GET/HEAD `/api/v1/blobs`, SHA-256 verification on upload, 25 MB cap, on-disk storage at `BLOB_STORAGE_DIR`. 7 endpoint tests.
- **M3.5** Background WS + notifications + context menu. MV3 Chrome extension fully functional.
- **M3.4** Context menu: "Send link with Beam" + "Send this tab with Beam".
- **M3.3** Toolbar popup: "Send this tab" button, E2EE encrypt + POST.
- **M3.2** First-run setup panel in popup.
- **M3.1** `apps/extension-chrome` bootstrap: WXT + React + Tailwind, MV3.
- **M2.5** Devices view: list paired devices, invite code generator.
- **M2.4** Send view: URL form, device selector, E2EE encrypt + POST.
- **M2.3** Inbox view: WS connect, decrypt + render URL cards.
- **M2.2** Onboarding: generate keys, register with server, IndexedDB keystore.
- **M2.1** `apps/web` bootstrap: Vite + React + Tailwind + TanStack Router.
- **M1.9** Dockerfile + docker-compose.yml for self-hosters.
- **M1.7** Ack endpoint: `POST /api/v1/envelopes/:id/ack`. Cascade-deletes
  envelope when all recipients acked. 9 envelope service tests.
- **M1.6** Send envelope endpoint: `POST /api/v1/envelopes`. Validates
  Ed25519 signature, wrappedKeys/to match, recipient exists, stores.
- **M1.5** WebSocket inbox: `GET /api/v1/ws`. Ed25519 challenge-response
  auth, ConnectionRegistry for online presence, drains inbox on connect,
  ping/pong keepalive. 8 WS session unit tests.
- **M1.4** Invite tokens: `POST /api/v1/invites` (requires signed-request
  auth from an existing device). Three scopes — signup, pair_device,
  peer. Single-use, TTL-clamped. Atomic consume-during-redeem.
- **M1.3** Device registration: `POST /api/v1/devices`. Three modes
  (first-device bootstrap, signup invite, pair_device invite).
  Signed-request auth middleware (`Beam-Sig` Authorization header,
  Ed25519 over canonical method/path/timestamp/body-hash) with 5-min
  clock-skew tolerance. 8 endpoint tests including full round-trip:
  device A registers → A issues invite → device B redeems → B is on a
  new user. Plus tamper-resistance test.
- **M1.2** Drizzle ORM + SQLite. Schema with 9 tables (users, devices,
  device_trusts, envelopes, recipients, blobs, peers, auth_credentials,
  invite_tokens). Generated initial migration. WAL mode, foreign keys
  enforced. `runMigrations()` runs at server startup.
- **M1.1** `apps/server` bootstrap: Hono app factory (testable), env-var
  config via valibot, pino structured logger, `/api/v1/health` endpoint.
  Smoke-tested live (boots, migrates, responds). 6 server tests.
- **M0.4** `packages/crypto` — Ed25519 + X25519 key generation,
  sign/verify, ECDH + HKDF + ChaCha20-Poly1305 wrap/unwrap. 21 tests
  including key-binding, ciphertext-tampering, wrong-recipient
  rejection, multi-recipient round-trip. Runs in browser and Node.
- **M0.3** `packages/protocol` — envelope and payload schemas (valibot),
  protocol version constant, canonical JSON serialization for signing.
  13 tests for canonical-form determinism.
- **M0.2** GitHub Actions CI: `pnpm lint` + `pnpm typecheck` + `pnpm test`
  on every PR.
- **M0.1** Repo bootstrapped: SPEC.md, PLAN.md, AGPL-3.0 license,
  pnpm/Turborepo workspace, Biome lint/format, strict TS base.

## Decision log

- **2026-05-22 (later)** — Crypto design locked: 32-byte Ed25519 seed for
  signing, X25519 for ECDH, HKDF-SHA256 with per-recipient device-ID
  binding, ChaCha20-Poly1305 for both key wrap and payload encryption.
  Random 12-byte nonce on payload, all-zero nonce on key wrap (safe
  because wrap key is unique per (ephemeral keypair, recipient)).
  base64url everywhere on the wire. `@noble/*` libs for primitives.
- **2026-05-22** — Repo bootstrapped. Decisions captured in SPEC.md:
  E2EE-required server, TS monorepo, Hono+Node server, React web app,
  WXT Chrome extension, AGPL-3.0, Syncthing-style federation. MVP slice
  = server + web + chrome extension.
