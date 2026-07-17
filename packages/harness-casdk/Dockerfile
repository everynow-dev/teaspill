# syntax=docker/dockerfile:1
# CASDK harness runtime image (T7.3, PLAN.md Phase 7). A container image
# variant that bundles the CASDK CLI subprocess (`@anthropic-ai/claude-agent-sdk`
# pinned 0.3.211, bundled CLI 2.1.211 — see ./README.md) for an agent-loop
# deployment using `@teaspill/harness-casdk`. See ./PACKAGING.md for env
# vars, the session-volume/cleanup discipline, and how this fits into a
# self-hosted teaspill stack (docs/self-hosting-networking.md).
#
# NOT wired into docker-compose.yml (T1.1's stack) or any of its Dockerfiles
# — this is a standalone runtime-packaging variant a developer's agent-loop
# service builds FROM (or copies the pattern of) once they have their own
# `defineAgent(...)` app. PACKAGING.md documents both paths.
#
# Build context is the pnpm WORKSPACE ROOT (not this package directory) —
# unlike packages/gateway/Dockerfile (which consumes a single pre-bundled
# .mjs and can use a per-package context), this image runs `pnpm deploy`
# inside the build, which needs the workspace lockfile plus this package's
# in-repo dependencies (@teaspill/schema, @teaspill/harness-native) to
# resolve. Build from the repo root:
#
#   docker build -f packages/harness-casdk/Dockerfile -t teaspill-harness-casdk .
#
# Running `pnpm deploy`/`pnpm install` INSIDE this linux container (not on
# the host) matters: `@anthropic-ai/claude-agent-sdk`'s CLI binary ships as a
# set of platform-gated `optionalDependencies`
# (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), resolved by
# npm/pnpm's os/cpu gate at INSTALL time. Building on a macOS host still
# yields the correct linux binary for the container's target platform,
# because install happens inside the linux build stage, never on the host.

# ---- build stage ------------------------------------------------------------
FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate
WORKDIR /repo

# Only this package's in-workspace dependency closet — @teaspill/harness-casdk
# depends on @teaspill/harness-native and @teaspill/schema (its package.json),
# nothing else in the workspace. pnpm resolves a workspace install fine with
# only the present subset of `packages/*` on disk (verified: T7.3 WORKLOG).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/harness-casdk/package.json packages/harness-casdk/package.json
COPY packages/harness-native/package.json packages/harness-native/package.json
COPY packages/schema/package.json packages/schema/package.json
RUN pnpm install --frozen-lockfile

COPY packages/harness-casdk packages/harness-casdk
COPY packages/harness-native packages/harness-native
COPY packages/schema packages/schema

RUN pnpm --filter @teaspill/harness-casdk... build

# `pnpm deploy` (pnpm's built-in mechanism for producing a self-contained,
# --prod-pruned install of exactly ONE workspace package, workspace:* deps
# inlined as real copies) — the standard pnpm+Docker pattern, and what makes
# this "multi-stage build the workspace + @teaspill/harness-casdk" concrete.
# `--legacy`: this workspace does not set `inject-workspace-packages=true`
# (pnpm v10+ default requires opting in or falling back explicitly).
RUN pnpm --filter @teaspill/harness-casdk deploy --prod --legacy /out

# Boot-probe the bundled CLI subprocess at BUILD time too, not just at
# container-runtime HEALTHCHECK — a broken/missing binary fails the image
# build, the same "fail fast, not at first boot" shape as the gateway
# image's GATEWAY_SMOKE build-time run (packages/gateway/Dockerfile).
COPY packages/harness-casdk/docker/cli-path.mjs packages/harness-casdk/docker/healthcheck.mjs /out/docker/
RUN node /out/docker/healthcheck.mjs

# ---- runtime stage -----------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/ ./
COPY packages/harness-casdk/docker/entrypoint.mjs ./docker/entrypoint.mjs

# Persistent volume for the SessionStore / JSONL-mirror discipline
# (session-store.ts `createFileSessionStore`) — see PACKAGING.md "Volume +
# cleanup discipline". Every entity's session transcript + meta.json lives
# under this mount; losing it only costs a cold rebuild (D5), but keeping it
# on durable storage is what makes the warm path (the hot path, T7.1) pay off.
ENV TEASPILL_CASDK_SESSION_DIR=/data/casdk-sessions
VOLUME ["/data/casdk-sessions"]

RUN mkdir -p /data/casdk-sessions && chown -R node:node /data/casdk-sessions /app
USER node

# Verifies the CLI boots (PLAN.md T7.3) — decoupled from whatever
# agent-loop server CMD runs; see docker/healthcheck.mjs module doc.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD ["node", "docker/healthcheck.mjs"]

# EXAMPLE/reference entrypoint — see docker/entrypoint.mjs and
# PACKAGING.md "Wiring your own app". Replace CMD (or the file at
# docker/entrypoint.mjs) with your own defineAgent(...) + serve() app.
CMD ["node", "docker/entrypoint.mjs"]
