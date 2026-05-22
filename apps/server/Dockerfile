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

# Build-time identification surfaced on /health for "what's running on
# this instance?" — pass with `docker build --build-arg GIT_SHA=$(git
# rev-parse HEAD) ...`. Empty string is fine; the server falls back to
# 'unknown' when neither this env nor a usable .git is available.
ARG GIT_SHA=""
ENV BEAM_GIT_SHA=$GIT_SHA

EXPOSE 3000
ENV PORT=3000
ENV DATABASE_URL=/data/beam.db
ENV BLOB_STORAGE_DIR=/data/blobs

VOLUME ["/data"]

CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
