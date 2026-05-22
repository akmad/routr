# Changelog

All notable changes to this project will be documented in this file.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are not yet tagged — the project has been pre-1.0 since
bootstrap.

## Unreleased — MVP

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
