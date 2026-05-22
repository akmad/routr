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

- [x] **M0.1** Initial repo scaffolding (this PR)
  - [x] Write SPEC.md
  - [x] Write PLAN.md
  - [x] README.md
  - [x] LICENSE (AGPL-3.0)
  - [x] .gitignore, .editorconfig
  - [x] Root package.json + pnpm-workspace.yaml
  - [x] tsconfig.base.json
  - [x] biome.json + turbo.json
  - [x] Empty `apps/` and `packages/` directories
  - [x] Push + open draft PR

## Next

- [ ] **M1.3** Device registration: `POST /api/v1/devices` accepts identity
  pubkeys, returns device ID. First request creates the user if no users
  exist yet; subsequent requests need a pairing invite token.
- [ ] **M1.4** Pairing invite tokens: `POST /api/v1/invites` (auth'd)
  → token; `GET /api/v1/invites/:token` to look up before redeeming.
- [ ] **M1.5** WebSocket inbox endpoint at `/api/v1/ws`. Auth'd via
  short-lived bearer token. Pushes queued envelopes on connect.

## Backlog (scoped, not started)

### Milestone 1 — Server skeleton

- [ ] **M1.3** Device registration endpoint: `POST /api/v1/devices`.
  Accepts identity pubkeys, returns device ID.
- [ ] **M1.4** WebAuthn registration + login flow (first device only;
  subsequent devices use pairing).
- [ ] **M1.5** Inbox WebSocket: `GET /api/v1/ws?device_id=...`.
  Authenticated via short-lived token. Delivers queued envelopes on
  connect.
- [ ] **M1.6** Send envelope endpoint: `POST /api/v1/envelopes`. Server
  validates signature shape (not content), stores, pushes to online
  recipients, queues for offline.
- [ ] **M1.7** Ack endpoint: `POST /api/v1/envelopes/:id/ack`. Marks
  recipient as acked. Deletes envelope when all recipients acked.
- [ ] **M1.8** Blob upload + download: chunked PUT, range GET, integrity
  hash check.
- [ ] **M1.9** Dockerfile + docker-compose.yml for self-hosters.

### Milestone 2 — Web app

- [ ] **M2.1** `apps/web` bootstrap: Vite + React + Tailwind + TanStack
  Router. Empty shell with routes for `/setup`, `/inbox`, `/send`,
  `/devices`, `/settings`.
- [ ] **M2.2** Onboarding: detect no-account state, create user, generate
  device keys, register with server, store private keys in IndexedDB
  behind a passphrase (later) / plaintext (MVP).
- [ ] **M2.3** Inbox view: connect WS, list received messages,
  decrypt + render URL cards and file download links.
- [ ] **M2.4** Send view: enter URL or pick file, choose recipient
  device, encrypt + send.
- [ ] **M2.5** Devices view: list paired devices, pair a new device
  (show QR), revoke a device.

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

## Done

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
