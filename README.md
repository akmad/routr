# Beam

[![CI](https://github.com/akmad/routr/actions/workflows/ci.yml/badge.svg)](https://github.com/akmad/routr/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_3.0-blue.svg)](./LICENSE)

> **Status:** MVP. Server + web app + Chrome extension work end-to-end on
> a single host. See [PLAN.md](./PLAN.md) for what's done and what's next.

Beam is an open-source, self-hostable replacement for PushBullet. Send URLs and
files between your devices — phone, tablet, laptop, browser — using each
platform's native Share affordance. End-to-end encrypted by default; the server
is a dumb pipe that never sees your message contents.

Project codename / repo / CLI: `routr`. User-facing name: **Beam**.

## What works today

- **Server** — Hono + SQLite, E2EE envelope routing, device-to-device WS
  delivery, signed-request REST auth, invite-based pairing, blob storage.
- **Web app** — `apps/web`: setup, inbox, send, devices, settings. Keys
  in IndexedDB; live decryption in the browser.
- **Chrome extension** — `apps/extension-chrome`: popup "Send this tab",
  context-menu items, background WS with desktop notifications on incoming.

## Self-hosting (Docker)

```bash
git clone https://github.com/akmad/routr.git
cd routr
docker compose up -d
```

The server listens on `:3000`. The first device to register becomes the
admin (no invite needed); after that, new devices require an invite from
an existing one.

To run without Docker (Node 22+):

```bash
pnpm install
pnpm --filter @routr/server start
```

Environment variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | `data/routr.db` | SQLite file path (or `:memory:`) |
| `BLOB_STORAGE_DIR` | `data/blobs` | Where opaque blob files live |
| `LOG_LEVEL` | `info` | pino log level |

### Reverse proxy + HTTPS

Terminate TLS in front of Beam — it speaks plain HTTP/WS. Caddyfile:

```
beam.example.com {
  reverse_proxy localhost:3000
}
```

Or with nginx, make sure to forward the `Upgrade` and `Connection`
headers so `/api/v1/ws` works:

```nginx
location /api/v1/ws {
  proxy_pass http://localhost:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
location / {
  proxy_pass http://localhost:3000;
  proxy_set_header Host $host;
}
```

### First-run

1. Open `https://your-beam.example.com` (the web app), or load the
   Chrome extension's popup.
2. Enter your server URL, leave the invite code blank — you're the
   first device, so you bootstrap the admin account.
3. To pair another device: open **Devices**, click *Generate invite*,
   and paste that code into the new device's setup screen.

## Planned (v1.0)

- Self-hostable server (single Docker container, SQLite by default)
- Web app — pair this browser as a device, send/receive, inbox
- Chrome extension — share the current tab via toolbar / right-click

## Planned (later)

- Firefox, Safari extensions
- Native desktop (macOS, Windows, Linux)
- iOS and Android apps
- Routing rules ("YouTube links go to Firefox")
- Cross-server peering (share with users on a different Beam server)

## Design principles

1. **E2E encrypted by default.** The server only sees ciphertext, metadata,
   and routing info. It cannot read your messages.
2. **Self-host first.** A single binary / Docker container, SQLite by default,
   zero external dependencies.
3. **Native share affordances.** Beam plugs into the OS / browser share sheet
   instead of inventing its own. You share to Beam the way you already share
   to anything else.
4. **No accounts unless you want them.** A Beam "account" is a set of devices
   that have cryptographically agreed to trust each other. Pairing a new device
   is a Syncthing-style code/QR exchange.

## Repository layout

See [SPEC.md §5](./SPEC.md#5-repo-layout).

## License

[AGPL-3.0](./LICENSE). If you run a modified Beam server and let other people
use it over a network, you have to share your modifications under the same
license. See the LICENSE file for the full text.

## Contributing

This is a personal project and not currently soliciting contributions, but you
are welcome to file issues and submit PRs. Discussion happens on GitHub Issues.
