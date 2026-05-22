FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ─── Install dependencies ─────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/crypto/package.json packages/crypto/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile

# ─── Runtime image ────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY packages/crypto/ packages/crypto/
COPY packages/protocol/ packages/protocol/
COPY apps/server/ apps/server/

EXPOSE 3000
ENV BEAM_PORT=3000
ENV BEAM_DB_PATH=/data/beam.db

VOLUME ["/data"]

CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
