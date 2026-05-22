# Contributing to Beam

Thanks for poking around! Beam is in active early development — the code
moves fast and the surface is small, so the most useful contributions
right now are bug reports and focused fixes rather than large new
features.

## Quick start

```bash
git clone https://github.com/akmad/routr.git
cd routr
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

Bring up the full stack locally:

```bash
# Terminal 1 — server
pnpm --filter @routr/server dev

# Terminal 2 — web app (proxies /api and /ws to localhost:3000)
pnpm --filter @routr/web dev

# Terminal 3 — Chrome extension (loads as an MV3 unpacked extension)
pnpm --filter @routr/extension-chrome dev
```

Then open <http://localhost:5173> for the web app, and load
`apps/extension-chrome/.output/chrome-mv3-dev` as an unpacked extension
in `chrome://extensions/`.

## Layout

```
apps/
  server/          Hono + SQLite server; routes the wire protocol
  web/             Vite + React + Tailwind SPA
  extension-chrome WXT MV3 extension
  e2e/             Playwright API-level E2E tests
packages/
  crypto/          Ed25519 + X25519 + ChaCha20-Poly1305 helpers (@noble)
  protocol/        Envelope/payload schemas + canonical JSON
docs/
  security-review.md   M4.3 crypto audit notes
SPEC.md            Product + protocol spec (source of truth)
PLAN.md            Living roadmap; updated each session
```

## Standards

- **TypeScript** strict mode everywhere; no `any` without justification.
- **Biome** for lint + format. `pnpm lint` and `pnpm exec biome check --write .` to auto-fix.
- **Vitest** for unit tests. Aim to add a test alongside any non-trivial behavior change.
- **Drizzle ORM + better-sqlite3**. Use `pnpm --filter @routr/server db:generate` to add a migration when changing `apps/server/src/db/schema.ts`.
- **Crypto:** never reach for primitives outside `@routr/crypto`. If something belongs there, add it with a test vector.

## Commits

- One logical change per commit.
- Conventional-ish prefixes: `feat:`, `fix:`, `test:`, `docs:`, `security:`, `chore:`.
- A two-line message body explaining the *why* is plenty.
- Don't squash multiple unrelated changes into one PR.

## Security issues

Please **don't** open a public issue for security-affecting findings.
Email the maintainer instead (see GitHub profile) or open a private
security advisory via GitHub.

## License

By contributing you agree your code is published under
[AGPL-3.0](./LICENSE).
