# Changelog

All notable changes to this project will be documented in this file.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are not yet tagged — the project has been pre-1.0 since
bootstrap.

## Unreleased — post-MVP polish

### Fixed
- **10-second timeout on the extension's `registerDevice` call.**
  Matches the same hang-protection added to the web setup probe —
  prevents the popup from staying stuck on "Setting up…" if the
  server URL silently drops packets.
- **Web setup probe now has a 10-second timeout.** Previously a server
  URL that silently hung (firewall dropping packets, wrong port behind
  a slow DNS) left the user staring at "Setting up…" forever — `fetch`
  has no default timeout. Now fails out with "Can't reach server:
  timed out after 10s" so the user can correct the URL.

### Added
- **Defensive response headers** on every server response:
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
  `Referrer-Policy: no-referrer`. The server emits only JSON and opaque
  binary blobs, so this is the safe minimum — stops MIME-sniffing on
  blob downloads, blocks framing, and keeps the server URL out of
  outbound Referer headers. 2 tests.
- **Copy buttons next to fingerprints and invite tokens** in the web app
  (Devices + Settings pages). One-click copies the value (with a
  hidden-textarea + `execCommand` fallback for insecure-context
  deployments) and flashes "Copied!" for 1.5s. Removes the
  triple-click-and-pray step from the out-of-band fingerprint
  verification and device-pairing flows.
- **Copy buttons next to fingerprints** in the Chrome extension popup —
  one-click copies "this device" or any paired device's fingerprint so
  it's trivial to paste over Signal/SMS for out-of-band verification.
  Mirrors the same affordance just added to the web app.
- **`Cmd/Ctrl+Enter` to send** from anywhere in the web Send form.
  Mainly fills the gap in note mode (a bare Enter inserts a newline
  there); in URL mode it's just consistency. Discoverable via the Send
  button's hover tooltip.
- **Human-readable file sizes** in the web app (Inbox + Send pages): a
  small `formatBytes` helper picks the right unit so a 3.4 MB file no
  longer reads as "3482 KB" and a 1.5 GB file no longer reads as
  "1572864 KB". 4 unit tests.
- **Better invite-code placeholder + live length hint** on the web
  Setup page and the extension popup's first-run panel. Placeholder
  now says "43-char code from another device" instead of "optional",
  and a small amber hint appears when the entered text is the wrong
  length — catches the most common mistake (truncated paste) before
  the user submits and gets a generic server error.
- **Text notes** (PushBullet parity): a new `note` payload kind. Send any
  text between devices end-to-end encrypted.
- **Multi-recipient send** in the web app: "All my other devices" is the
  default; the protocol already supported `to: string[]`, only the UI
  needed to catch up.
- **Local Sent log**: `/sent` page in the web app shows what this device
  has sent (kind, recipients, summary, when). Server never sees this;
  it's strictly local IndexedDB.
- **Server connectivity probe** during web setup — fast clear failure if
  the URL is wrong, rather than waiting for the registration request to
  fail opaquely.
- **`Send image with Beam` context menu** in the extension: right-click
  an image, fetch the bytes in the background, ship as a file envelope.
- **Per-IP rate limiting** on `POST /api/v1/devices` and
  `POST /api/v1/envelopes` (token bucket).
- **Per-app NonceStore**: signed-request `(deviceId, timestamp)` tracking
  closes the 5-min replay window from M4.3 review.
- **`UNIQUE` index on `envelopes.signature`**: byte-identical replays now
  return HTTP 409 / `reason:'duplicate'`.
- **Device revocation**: `DELETE /api/v1/devices/:id` signed by a
  different device of the same user; cascade-deletes via FKs.
- **Device fingerprint UI** in both web and extension for out-of-band
  pairing verification.
- **`lastSeenAt`** recorded on every successful auth (REST + WS), shown
  on the Devices page as "seen Xm ago".
- **Admin stats endpoint** (`GET /api/v1/admin/stats`) for self-hosters.
- **Health endpoint** now returns `uptimeSec`.
- **Web favicon**.
- **Routing rules in the extension**: options page + storage + matcher.
- **Exponential WS reconnect** in both web (1s → 30s cap) and extension
  (1s → 60s cap), with backoff reset on successful auth.
- **CI build step**: `pnpm build` runs after lint/typecheck/test so
  Vite/WXT regressions can't sneak past.
- **Dependabot config + CONTRIBUTING.md + CHANGELOG.md**.

### Fixed
- **WS envelope wire-shape mismatch**: server sent
  `type: 'envelope', ...flat` but both clients listened for
  `type: 'inbox_envelope', envelope: {...}` — live push silently
  failed. Clients updated to match; added regression test.
- **Don't ack envelopes whose decryption failed**: previously we'd ack
  unconditionally, server would cascade-delete, and we'd lose the
  message. Now ack only on success; failed envelopes retry at next
  drain.
- **Device revocation detection**: web and extension now notice
  `unknown_device` (REST 401) or WS close-code 4002 and clear local
  identity instead of looping forever.
- **Vite dev WS proxy**: the WS endpoint at `/api/v1/ws` wasn't being
  proxied because the proxy rule was on `/ws` (which never matched).
- **Setup default Server URL**: now uses `window.location.origin` —
  the common self-hosted reverse-proxy case requires no input.
- **GET /api/v1/devices/:id**: was unauthenticated and leaked `userId`;
  now auth-gated and same-user-only.
- **Final ackEnvelope `not_found` semantics**: completely-unknown
  envelope IDs return `not_found`; double-ack after cascade-delete is
  also `not_found` (the record is genuinely gone — consistent with
  every other "envelope is missing" path).

## Pre-fork — MVP

### Added
- **Crypto** (`@routr/crypto`): Ed25519 sign/verify, X25519 ECDH,
  ChaCha20-Poly1305 sealed-envelope payload + key wrap, HKDF-SHA256 with
  per-recipient device-ID binding, device fingerprint helper.
- **Protocol** (`@routr/protocol`): envelope and payload valibot schemas,
  canonical JSON for cryptographic signing.
- **Server** (`apps/server`): Hono + better-sqlite3 + Drizzle. REST API
  for device registration, invite tokens (signup + pair_device + peer),
  envelope submit/ack with UNIQUE-signature replay defense, blob upload
  with SHA-256 verification, device revocation, WebSocket inbox with
  Ed25519 challenge auth, per-IP rate limits on enumeration targets,
  in-process nonce store for signed-request replay defense, periodic
  expired-envelope cleanup.
- **Web app** (`apps/web`): Vite + React + Tailwind + TanStack Router.
  Onboarding, inbox with live WS + exponential-backoff reconnect, send
  (URL or file), devices list with fingerprint display + revoke button,
  client-side routing rules with 5 pattern types, settings with this-
  device fingerprint. Detects revoked-by-other-device and bounces to
  setup.
- **Chrome extension** (`apps/extension-chrome`): WXT MV3. Setup panel,
  "Send this tab" with rule-based recipient pre-selection, file send,
  context-menu "Send link with Beam", desktop notifications on incoming
  URLs and files, options page for managing routing rules, fingerprint
  display, revocation detection.
- **E2E test harness** (`apps/e2e`): Playwright API-level tests against
  a real server instance.
- **Docker image + docker-compose** for self-hosters.

### Security
- M4.3 crypto review pass (see `docs/security-review.md`): no critical
  findings; documented six limitations with mitigation paths. Of those:
  L2 (signed-request replay), L3 (envelope replay), and the device-
  revocation gap are all fixed.

### Tests
- ~140 tests across `@routr/crypto`, `@routr/protocol`, `@routr/server`,
  `@routr/web`.
