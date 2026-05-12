# syntax=docker/dockerfile:1.7
# Build context: REPO ROOT (not apps/bridge/sidecar) so workspace deps resolve.
# CI and docker-compose are configured accordingly.

FROM node:22-alpine AS build
RUN apk add --no-cache git
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# Copy manifests + the shared tsconfig first for better layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/hmac/package.json packages/hmac/
COPY packages/schema/package.json packages/schema/
COPY apps/bridge/sidecar/package.json apps/bridge/sidecar/

# Install only what the sidecar (transitively) needs.
RUN pnpm install --frozen-lockfile --filter "@polaris-email/bridge-sidecar..."

# Copy sources for the sidecar and its workspace deps.
COPY packages/hmac packages/hmac
COPY packages/schema packages/schema
COPY apps/bridge/sidecar apps/bridge/sidecar

# Build workspace deps first, then the sidecar.
RUN pnpm --filter "@polaris-email/hmac" build \
 && pnpm --filter "@polaris-email/schema" build \
 && pnpm --filter "@polaris-email/bridge-sidecar" build

# Materialize a portable, production-only runtime directory at /out.
RUN pnpm --filter "@polaris-email/bridge-sidecar" --prod deploy /out

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /out/dist ./dist
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
