# Beam

> **Status:** early development. Not yet usable. See [PLAN.md](./PLAN.md) for progress.

Beam is an open-source, self-hostable replacement for PushBullet. Send URLs and
files between your devices — phone, tablet, laptop, browser — using each
platform's native Share affordance. End-to-end encrypted by default; the server
is a dumb pipe that never sees your message contents.

Project codename / repo / CLI: `routr`. User-facing name: **Beam**.

## What works today

Nothing yet — the repo is being bootstrapped. Watch [PLAN.md](./PLAN.md) for
the live status.

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
