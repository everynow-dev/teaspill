# @teaspill/docs

The public documentation site for teaspill. Built on the official
[Nuxt UI docs template](https://github.com/nuxt-ui-templates/docs)
(Nuxt 4 + Nuxt UI v4 + Nuxt Content 3), it is a static site: prerendered to
plain HTML/JS with no runtime services.

> This package currently ships the upstream template content as a placeholder.
> The teaspill theme, changelog, and real content land in later tasks of the
> docs-site plan.

## Requirements

- **Node.js >= 22.5.0** for `dev`, `build`, and `generate`.

  Nuxt Content is configured with `experimental.sqliteConnector: 'native'`
  (in `nuxt.config.ts`), which uses the built-in `node:sqlite` module. That
  module only exists on Node 22.5+ (it is not present on Node 20), so the docs
  site cannot be developed or built on the repo's minimum Node (`>=20.19.0`).
  The rest of the monorepo still runs on Node 20; only this package needs 22.
  If a Node-22 toolchain is not available, switch the connector to the
  cross-version `better-sqlite3` option instead — but `native` is preferred and
  is what the build is verified against.

## Scripts

Run from the repo root with `pnpm --filter @teaspill/docs <script>`, or from
this directory with `pnpm <script>`.

```bash
pnpm --filter @teaspill/docs dev        # dev server on http://localhost:3000
pnpm --filter @teaspill/docs build      # server build (.output)
pnpm --filter @teaspill/docs generate   # static prerender to .output/public
pnpm --filter @teaspill/docs preview    # preview a production build
pnpm --filter @teaspill/docs typecheck  # nuxt typecheck (vue-tsc)
pnpm --filter @teaspill/docs lint       # local @nuxt/eslint flat config
```

Linting: this package is excluded from the root `eslint.config.js` and lints
itself with the Nuxt-generated flat config (`eslint.config.mjs`), because the
strict repo-wide typescript-eslint config would fight Nuxt's Vue SFCs and
generated files.

## Static output & deployment

`generate` writes a fully static site to `.output/public`, deployable to any
static host. `NUXT_PUBLIC_SITE_URL` (see `.env.example`) is only needed to make
Open Graph image URLs absolute; `generate` succeeds without it. CI/deploy wiring
is handled by a later task.

## AI surface

The template's AI modules are kept: `nuxt-llms` (generates `/llms.txt` /
`/llms-full.txt`), `@nuxtjs/mcp-toolkit` (an MCP server at `/mcp` exposing
`list-pages` / `get-page`), and raw-markdown routes at `/raw/<path>.md`. Their
section mapping still reflects the template and is retargeted to teaspill's
real content in a later task.

## Changelog

The changelog is **content-driven**: each release is a plain markdown file, not
a runtime fetch of GitHub releases. Entries live in their own Nuxt Content
collection (`changelog`) and are rendered newest-first at `/changelog` by
`app/pages/changelog.vue` (via `UChangelogVersions` / `UChangelogVersion`).

### Authoring a new entry

1. Add a markdown file under `content/changelog/` (e.g.
   `content/changelog/v2.md`). The filename is not user-visible — entries are
   ordered by their `date` frontmatter, not by filename, so numeric prefixes are
   unnecessary.
2. Set the frontmatter:

   ```yaml
   ---
   title: teaspill v2 # heading shown on the entry
   description: One-line summary shown under the title.
   date: 2026-08-01 # ISO date; sorts the timeline (newest first)
   badge: v2 # optional pill (e.g. the version)
   image: /changelog/v2.png # optional hero image
   navigation: false # keep it out of any nav tree
   ---
   ```

3. Write the body as normal markdown / MDC. It renders below the title via
   `<ContentRenderer>`, so all prose and MDC components (callouts, code blocks,
   etc.) work.

Write entries in the **public voice** — a friendly release note, no internal
task/decision ids or repo-internal file paths.

The `changelog` collection is deliberately **excluded from the `docs`
collection's source glob** (`exclude: ['index.md', 'changelog/**']` in
`content.config.ts`). Because the sidebar navigation and the ⌘K search index are
both built from the `docs` collection, changelog entries never pollute the docs
nav or search.

### Future option: generate from Changesets

The repo root already uses `@changesets/cli`. A future enhancement could
generate `content/changelog/*.md` entries automatically from Changesets release
notes at publish time. This is intentionally **not** automated yet — entries are
authored by hand for now.

## Deployment

The site is static: `pnpm --filter @teaspill/docs generate` prerenders the whole
site to `packages/docs/.output/public/`, which any static host serves directly.

- **Set `NUXT_PUBLIC_SITE_URL`** at build time (e.g. `https://teaspill.everynow.dev`).
  It is used for absolute URLs in OG images and in `/llms.txt`. Without it the
  build still succeeds, but those URLs are relative.
- **Build on Node ≥ 22.5** (see [Requirements](#requirements) — the native
  sqlite connector). CI runs the docs build in its own Node-22 job
  (`.github/workflows/ci.yml`); the rest of the workspace stays on Node 20.

### Static hosting (any provider)

```bash
NUXT_PUBLIC_SITE_URL=https://teaspill.everynow.dev pnpm --filter @teaspill/docs generate
# then serve packages/docs/.output/public/ — e.g. locally:
npx serve packages/docs/.output/public
```

### Vercel

Nuxt is a first-class Vercel target. Point the project at this repo, set the
root/output for the `@teaspill/docs` package, add `NUXT_PUBLIC_SITE_URL` as an
env var, and use `pnpm --filter @teaspill/docs generate` as the build command
(output `packages/docs/.output/public`). Nitro also has a native Vercel preset
(`nitro build --preset vercel`) if you prefer serverless output over a pure
static deploy.

> The actual host and domain are a deployment decision. This worktree has no git
> remote configured; before wiring a provider, add one:
> `git remote add origin git@github.com:everynow-dev/teaspill.git`.
