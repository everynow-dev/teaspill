# Template & reference research digest (2026-07-18)

Fetched by the plan-authoring session. Facts below were verified against the
repos / npm registry on the date above; content agents should trust this digest
and only re-fetch if something fails to match reality.

---

## 1. Nuxt UI docs template — github.com/nuxt-ui-templates/docs

- Live demo: https://docs-template.nuxt.dev/ · Scaffold: `npm create nuxt@latest -- -t ui/docs`
- **Versions (main branch package.json):** `nuxt` ^4.4.8, `@nuxt/ui` ^4.10.0
  (**free — NOT Pro**), `@nuxt/content` ^3.15.0, `@nuxt/image` ^2.0.0,
  `nuxt-og-image` ^6.7.2 (+ `@takumi-rs/core`), `nuxt-llms` 0.2.0,
  `@nuxtjs/mcp-toolkit` ^0.18.0, `@nuxtjs/mdc` ^0.22.1, `tailwindcss` ^4.3.2,
  `zod` ^4, `minimark`, `ufo`. Dev: `@nuxt/eslint`, `typescript` ^6.0.3,
  `vue-tsc` ^3.3.7. `packageManager: pnpm@11.13.1`, CI Node 22 (lint +
  typecheck only).

### Directory structure (Nuxt 4 `app/` layout)

```
app/
  app.vue                 # UApp shell, header/footer, LazyUContentSearch
  app.config.ts           # theme colors, header/footer/toc config (data-driven)
  error.vue
  assets/css/main.css
  components/ AppHeader.vue, AppFooter.vue, AppLogo.vue, PageHeaderLinks.vue,
              TemplateMenu.vue, OgImage/Docs.takumi.vue,
              content/HeroBackground.vue, content/StarsBg.vue
  layouts/docs.vue        # UContainer > UPage with #left UPageAside > UContentNavigation
  pages/index.vue         # landing, renders content/index.md with :prose="false"
  pages/[...slug].vue     # catch-all docs page
content/
  index.md                # landing (MDC components)
  1.getting-started/ .navigation.yml, 1.index.md, 2.installation.md, 3.usage.md
  2.essentials/ .navigation.yml, 1.markdown-syntax.md, 2.code-blocks.md,
                3.prose-components.md, 4.images-embeds.md
  3.ai/ .navigation.yml, 1.mcp.md, 2.llms.md
content.config.ts
nuxt.config.ts
server/
  mcp/tools/get-page.ts, list-pages.ts     # MCP server tools
  routes/raw/[...slug].md.get.ts           # serves raw markdown per page
.env.example              # NUXT_PUBLIC_SITE_URL (for OG images with nuxt generate)
```

### Mechanics

- **Content org:** Nuxt Content v3 collections in `content.config.ts` — two
  collections: `landing` (type page, `index.md`) and `docs` (type page,
  `include: '**'`, exclude index.md, zod schema adds optional `links[]`
  frontmatter for page-header buttons). Numeric prefixes (`1.getting-started/`,
  `2.installation.md`) drive ordering; `.navigation.yml` per directory sets
  group title/icon; per-page `navigation.icon` frontmatter.
- **Navigation:** auto-generated. `app.vue` runs
  `queryCollectionNavigation('docs')` + `queryCollectionSearchSections('docs')`,
  `provide('navigation', ...)`; layout injects into `UContentNavigation`
  (sidebar + `UHeader` `#body` mobile).
- **Catch-all page:** `queryCollection('docs').path(route.path).first()` → 404
  on miss; `queryCollectionItemSurroundings` for prev/next; `findPageHeadline`
  from `@nuxt/content/utils`; `defineOgImage('Docs', ...)`. Template: `UPage` >
  `UPageHeader` > `UPageBody` > `ContentRenderer` + `USeparator` +
  `UContentSurround`; `#right`: `UContentToc` with `UPageLinks` bottom
  (community/edit links from app.config, incl. "Edit this page" GitHub link).
- **Components in play:** `UApp`, `UHeader`, `UMain`, `UContainer`, `UPage`,
  `UPageAside`, `UPageHeader`, `UPageBody`, `UPageLinks`,
  `UContentNavigation`, `UContentToc`, `UContentSurround`,
  `UContentSearch`/`UContentSearchButton`, `ContentRenderer`,
  `UColorModeButton`/`UColorModeImage`, `UFooter`. Landing MDC:
  `::u-page-hero`, `::u-page-section`, `::u-page-feature`, `::u-page-c-t-a`.
  Prose/MDC demonstrated in `content/2.essentials/`: `accordion`/
  `accordion-item`, `badge`, `callout`, `note`, `tip`, `warning`, `caution`,
  `card`, `card-group`, `code-preview`, `code-group`, `code-tree`,
  `code-collapse`, tabs/steps, fenced code with `[filename]` labels.
- **Search:** built-in full-text `LazyUContentSearch` (⌘K) fed by
  `queryCollectionSearchSections('docs')`. No Algolia.
- **Theming:** `app.config.ts` `ui.colors` (template default primary: green,
  neutral: slate), Tailwind v4 via `main.css`, dark mode via
  `UColorModeButton`, light/dark logo variants.
- **AI/LLM surface:** `nuxt-llms` generates `/llms.txt` (sections mapped to
  collection filters in nuxt.config); `@nuxtjs/mcp-toolkit` exposes
  `list-pages`/`get-page` MCP tools reading `/raw/<path>.md`;
  `server/routes/raw/[...slug].md.get.ts` re-serializes pages to markdown via
  `minimark`.
- **Deployment:** static-friendly — `nitro.prerender: { routes: ['/'],
  crawlLinks: true }`; `ogImage: { zeroRuntime: true }`; Content
  `experimental.sqliteConnector: 'native'`. `compatibilityDate: '2026-06-30'`.

## 2. Nuxt UI changelog template — github.com/nuxt-ui-templates/changelog

- Demo: https://changelog-template.nuxt.dev/
- **Entries are NOT markdown files.** No `content/`, no Nuxt Content.
  `app/pages/index.vue` fetches GitHub releases at runtime from
  `https://ungh.cc/repos/<owner>/<repo>/releases` (repo key in app.config) and
  renders release markdown with **Comark** (`@comark/nuxt`), not MDC.
- Key components: `UChangelogVersions` + `UChangelogVersion` (both free Nuxt
  UI v4 — timeline with sticky date indicators), `UPageSection`.
- **Merge verdict:** for teaspill, skip ungh/Comark. Author changelog entries
  as a Nuxt Content collection rendered into
  `UChangelogVersions`/`UChangelogVersion` via `ContentRenderer` — one
  markdown pipeline, prerenderable, no runtime GitHub dependency. Both
  templates share `@nuxt/ui` v4 / Nuxt 4 / eslint config, so no version
  conflict. `UChangelogVersion` expects title/date/description/image/authors —
  map from frontmatter.

## 3. Style references (concrete pages to imitate)

### Nuxt docs — nuxt.com/docs/4.x

Organization: Get Started → Guide (Concepts / Directory Structure / Going
Further / Recipes) → API → Examples → Community. Getting Started is a linear
tutorial spine. Style traits: short declarative opening sentence stating the
page's promise; concept-first prose then bullet feature lists; heavy
progressive disclosure via "Read more in …" callout links instead of inlining;
file-path-labeled code blocks; note/tip/warning callouts for asides; every
page has TOC, edit link, prev/next. Pages stay short; depth lives in linked
pages (hub-and-spoke).

Imitate:
- https://nuxt.com/docs/4.x/getting-started/introduction — high-level pitch + linked drill-downs
- https://nuxt.com/docs/4.x/getting-started/installation — prerequisites, terminal blocks, next-steps
- https://nuxt.com/docs/4.x/getting-started/data-fetching — concept + progressively deeper examples, heavy callouts
- https://nuxt.com/docs/4.x/guide/directory-structure/app/pages — reference-page pattern: convention table + examples
- https://nuxt.com/docs/4.x/getting-started/routing — short hub page delegating via "Read more" links

### Laravel docs — laravel.com/docs (13.x)

Sidebar: one flat curated list grouped by theme; page names are plain nouns
("Routing", "Queues"). Typical page: anchor-linked mini-TOC at top, then
task-oriented `##` sections, each = 1–2 sentence plain-English claim →
minimal copy-pasteable code block → variations; warnings as callouts. Tone:
confident, second-person, zero fluff; explains the why in one line, then
shows code. Simple-to-advanced ordering *within* each page (progressive
disclosure inside the page — opposite pole from Nuxt's hub-and-spoke; the
style guide should pick per-section which pattern fits).

Imitate:
- https://laravel.com/docs/13.x/routing
- https://laravel.com/docs/13.x/validation
- https://laravel.com/docs/13.x/queues

## 4. Version facts (npm registry, 2026-07-18)

- `nuxt` latest = **4.4.8** · `@nuxt/ui` latest = **4.10.0** ·
  `@nuxt/content` latest = **3.15.0**.
- `@nuxt/ui-pro` frozen at 3.3.7 (last publish 2025-10-23) — **Nuxt UI v4
  merged Pro into free open-source `@nuxt/ui`** (Sept 2025): all
  Page/Content/Changelog/Dashboard components are free. Sources:
  https://nuxt.com/blog/nuxt-ui-v4 ·
  https://github.com/nuxt/ui/releases/tag/v4.0.0. The docs template depends
  only on free `@nuxt/ui` — no license, no env var beyond
  `NUXT_PUBLIC_SITE_URL`.
