# 0003 — Decisions ledger

## Inherited (binding, not copied)

- `0001:D1–D8` — core architecture (sources of truth, Restate coordination, outbox projection, service planes, harness abstraction, deployment/auth, lifecycle, dropped scope). See `work/plans/0001-build-v1/DECISIONS.md`.
- `0001:A1–A10` — amendments (seq 0-based gapless, tenant/tags schema, service naming, cancellation constraints, schema freeze v1, producer reality, retention, control-verb seams, reconciler epoch/offset stance, resurrection/onWake).
- Any amendments recorded in `work/plans/0002-follow-ups/DECISIONS.md` (0002 is active and in flight).
- These bind the *content* of the docs: the site describes this architecture; it never contradicts it.

Superseding an inherited decision requires an amendment below naming the qualified id it supersedes.

---

## Plan decisions

### D1 — Docs site stack: workspace package on the Nuxt UI docs template
`packages/docs` (`@teaspill/docs`, private), scaffolded from `nuxt-ui-templates/docs`: Nuxt ^4.4.8, `@nuxt/ui` ^4.10.0 (free — Pro was merged into free in v4), `@nuxt/content` ^3.15.0, Tailwind v4, TypeScript ^6.0.3 (within the repo's `<6.1.0` cap). Static-first (`nitro.prerender` + crawl), no runtime services. **Why:** official template, actively maintained, zero license cost, matches the repo's TS pin, and ships search, navigation, prose components, llms.txt and an MCP surface out of the box. Verified facts in `notes/template-research.md`.

### D2 — Changelog is content-driven, not release-fetched
The changelog lives as a Nuxt Content collection (`content/changelog/*.md`) rendered with `UChangelogVersions`/`UChangelogVersion`, not the changelog template's runtime fetch of GitHub releases via ungh.cc + Comark. **Why:** one markdown pipeline (MDC) instead of two renderers, prerenderable/offline, no runtime third-party dependency, and teaspill has no public GitHub releases to fetch yet. Future option (noted, not built): generate entries from Changesets releases — the root repo already uses `@changesets/cli`.

### D3 — The site is the single public documentation source; `docs/` retires to a stub
After content migration (Gate 2 conditions in PLAN §4), the repo's `docs/*.md` guides are deleted and `docs/README.md` becomes a stub pointing to the site and, for design history, to `work/` ledgers + package READMEs. Internal-only artifacts the IA (T2.1) chooses not to publish are relocated (e.g. into `work/plans/0001-build-v1/notes/`), not silently dropped. **Why:** two parallel doc sets drift; the site must be the one that is true. The cost — AI agents lose `docs/`-file pointers into plan context — is accepted: `work/` ledgers, package READMEs, and code comments remain the agent-facing context, and the stub says where to look. Old content stays reachable in git history.

### D4 — Public-voice rule
Public pages contain zero references to plan files, task/decision/amendment ids, `work/` paths, ledger names, or internal doc filenames. Necessary context is explained inline; fuller background goes into an expandable prose component with a plain-language summary (exact pattern standardized by T2.1). One sanctioned exception: the contributing section may link to `work/` for design history, with wording set by T2.1. **Why:** internal bookkeeping references make public docs confusing and leak process noise; the didactic requirement demands self-contained explanations. Enforced by grep audit in T4.2.

### D5 — Visual identity: "spilled tea"
Custom theme replacing the template's green/slate: warm amber/copper primary (steeped-tea, not mustard), `stone` warm neutral, matcha green accent, dark mode in warm near-black ("dark oolong"); Fraunces for display/headings, humanist sans for body, JetBrains Mono for code, via `@nuxt/fonts`; teaspill wordmark + minimal teacup/spill mark, light/dark variants, matching OG images. Final concrete values (palette hex/ramp choices, font weights) are recorded by T1.2's WORKLOG entry — this decision binds the direction, not the hex codes. **Why:** the site should be recognizably ours; the name is the brand.

---

## Amendments log

(none yet)
