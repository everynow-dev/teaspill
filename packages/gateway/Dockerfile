# syntax=docker/dockerfile:1
# Gateway image (T1.2). Compose builds this with context ./packages/gateway
# (docker-compose.yml), which does NOT include the pnpm workspace root — so
# workspace deps (@teaspill/catalog) can't be installed inside the build.
# Instead the image consumes a single self-contained ESM bundle produced on
# the host by:
#
#   pnpm --filter @teaspill/gateway bundle    # -> dist/docker/server.mjs
#
# (esbuild inlines workspace + npm deps; everything is pure JS, no natives).
# Run that before `docker compose build gateway`. If dist/docker/ is missing
# the COPY below fails fast with an obvious error.

# ---- build/verify stage ----------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY dist/docker/server.mjs ./server.mjs
# Smoke-run the bundle's whole import graph (server.ts exits 0 immediately
# under GATEWAY_SMOKE=1) so a broken bundle fails the image build, not the
# container at runtime.
RUN GATEWAY_SMOKE=1 node server.mjs

# ---- runtime stage ----------------------------------------------------------
FROM node:22-slim
# docker-compose.yml's gateway healthcheck execs `wget` inside the container;
# node:22-slim doesn't ship it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server.mjs ./server.mjs
USER node
EXPOSE 8787
CMD ["node", "server.mjs"]
