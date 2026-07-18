# teaspill docs — writing style guide (T2.1)

The document every content agent (T3.x) obeys. Read it in full before writing a word.
Companion: `notes/ia.md` (the page tree, source pointers, per-page ownership).

Scope: everything under `packages/docs/content/`. The rules here are checked at Gate 1
(taste review) and Gate 3 (T4.2 fresh-eyes + grep audit). Where this guide and the
reference pages disagree with your instincts, the guide wins; where the guide is silent,
imitate the cited reference page for your page's pattern (§2).

---

## 1. Voice and tone

- **Didactic, confident, second-person.** Address the reader as "you". Present tense,
  active voice, declarative sentences. Explain *why* in one line, then show the thing.
  (Borrowed from Laravel throughout: "You may use the `validateWithBag` method…" —
  laravel.com/docs/13.x/validation.)
- **No fluff.** Ban: "simply", "just", "easy", "powerful", "seamless", "robust",
  "blazing", "note that" as filler, and apologies ("unfortunately"). If a sentence
  survives deletion of its adjectives, delete them.
- **Problem-first openings for concept-heavy material.** Introduce a mechanism by the
  problem it removes, the way Laravel's queues page opens ("you may have some tasks…
  that take too long to perform during a typical web request" —
  laravel.com/docs/13.x/queues). teaspill's equivalents: "your agent's process can die
  mid-run", "your UI joins a conversation that started an hour ago".
- **Short + friendly is the register.** The Nuxt reference pages prove short pages can
  teach; beginner-friendly never means verbose. Cut before you caveat.
- **One running example per section.** Reuse a single concrete example through a page
  (Laravel's `ProcessPodcast` technique — laravel.com/docs/13.x/queues). Ours is the
  **`researcher` agent that spawns a `summarizer`** (already the example in the SDK
  sources); use it site-wide unless a page has a stronger domain reason not to.
- **Analogies must not lie.** When you simplify, prefer "Roughly: …" followed by the
  expandable precise version (§5) over a false simple claim. A simplification that a
  careful reader could falsify against the code is a bug.
- Spelling: American English. "teaspill" is always lowercase, even at sentence start
  (recast the sentence if it looks odd). Proper names: Restate, Electric, Postgres,
  Docker, Claude Agent SDK. Say "the durable streams server" (prose) for the history
  store; never the image/package name in prose.

## 2. Two page patterns — and which sections use which

The two reference styles sit at opposite poles of progressive disclosure. Pick per
section, not per whim:

**Pattern A — Nuxt-style hub page (short, spokes via links).**
Short page (500–900 words). Each `##` section: 2–4 sentences of explanation, at most one
small code block, then a "read more" spoke — a `::callout` linking to the page that goes
deeper. Depth lives in the linked page, never inlined. (Model:
nuxt.com/docs/4.x/getting-started/routing — every section summarizes and delegates;
nuxt.com/docs/4.x/getting-started/introduction — concept pitch with zero code and
"Read more in…" links.)

**Pattern B — Laravel-style task page (long, depth in-page).**
One page owns a task end to end. Ordered `##` sections, simple → advanced *within* the
page. Each section: a 1–2 sentence plain-English claim → a minimal copy-pasteable code
block → variations. Navigability comes from the right-rail TOC (the template generates
it from headings), so headings must be plain nouns/verb phrases ("Registering your
deployment", not "Networking considerations, part 2"). (Model:
laravel.com/docs/13.x/routing — claim → code → variations, flat anchor TOC;
laravel.com/docs/13.x/validation — a quickstart walkthrough first, then the rulebook.)

| Section | Pattern | Notes |
|---|---|---|
| Landing (`index.md`) | neither — MDC hero/features page | 30-second pitch; see ia.md |
| Getting Started | **A**, except the quick start | Introduction imitates Nuxt's introduction; installation imitates Nuxt's installation (prereq bullets, sequenced steps, a "you should now see…" success checkpoint, one forward link at the end). |
| Quick start | **B (walkthrough variant)** | One linear build, every block runnable, `::steps` allowed. The Laravel validation quickstart is the model: complete flow first, options later. |
| Concepts | **A** | The ramp (§4) lives here. Short pages, heavy cross-linking, depth deferred to Guides/Reference spokes. |
| Guides | **B** | Task pages. Claim → runnable code → variations. |
| Reference | **B (spec variant)** | Convention/field tables + short examples, the nuxt.com/docs/4.x/guide/directory-structure/app/pages pattern: convention → example → resulting behavior, identical structure per entry. Terse is correct here. |
| Contributing | **A** for the hub, table + short sections for the package map | |
| Changelog | frontmatter-driven entries (T1.3 shell) | Public voice, newest first. |

**The tiered "in a nutshell" device.** When a page presents 2–3 alternatives (native vs
Claude Agent SDK harness; API key vs read token; `wait` vs `finish`), open the section
with a ranked one-liner per option so readers self-select, exactly like Nuxt's
data-fetching page ("`$fetch` is the simplest way… `useFetch` is a wrapper… `useAsyncData`
offers more fine-grained control" — nuxt.com/docs/4.x/getting-started/data-fetching),
then give trade-offs, not prescriptions.

## 3. Page anatomy

Every docs page, in order:

1. **Frontmatter:** `title` (plain noun phrase, ≤ 4 words where possible — Laravel-style
   sidebar names: "Addressing", "Self-hosting", "Timelines & events"), `description`
   (one sentence, used by SEO/OG and search), `navigation.icon` (lucide icon).
2. **The opening promise sentence.** The first sentence states what the page teaches or
   what the feature does for the reader — not history, not architecture trivia.
   Good: "Every agent writes an append-only timeline of everything it does, and your UI
   can replay or live-follow it." Bad: "Timelines were introduced to solve projection
   consistency."
3. **Body per the page's pattern (§2).**
4. **Callouts** — four types, used sparingly (≤ 1 per screenful as a norm):
   - `::note` — neutral context or a pointer ("Read more in …" spokes are notes/callouts
     with a link, the Nuxt device).
   - `::tip` — optional improvement, nicer way, dev-ergonomics.
   - `::warning` — a footgun that fails loudly or wastes your time
     (e.g. registering `localhost` instead of `host.docker.internal`).
   - `::caution` — data loss, security, irreversibility (e.g. Docker socket mount is
     root-equivalent; restoring without the coordination store loses active agents).
   Callouts appear **where the confusion happens**, not batched at the end (Laravel
   places "connections vs queues" exactly where a newcomer would conflate them).
5. **Code blocks:**
   - Always language-tagged; label with a file path whenever the code lives in a file:
     ` ```ts [agents/researcher.ts] `. Terminal blocks are ` ```sh ` and contain no `$`
     prompts. Output goes in a separate block or a comment, never mixed into commands.
   - Copy-pasteable against the current repo. If a block can't be run verbatim, it must
     say why in a comment (`# replace <id> with the id printed above`).
   - Progressive complexity: the first block of a section is the minimal form; variations
     extend it (Laravel's dispatch → dispatch-with-options progression).
   - Use `::code-group` for genuinely alternative forms (e.g. CLI vs HTTP vs SDK for the
     same action), the way Nuxt's installation page tabs package managers. Never tab
     things that aren't alternatives.
6. **Prev/next flow:** the template renders surround links automatically from the page
   tree. Write each section assuming linear reading *within its section*: never say
   "as you saw above" across pages, and make the last `##` of tutorial-spine pages a
   short "Next steps" pointing forward (one link, one sentence — Nuxt installation's
   close: "you are ready to start building").
7. **TOC:** generated from `##`/`###`. Every page longer than two screens needs at least
   three `##` headings so the TOC is useful. Don't exceed `###` depth.

## 4. The terminology ramp

**The rule (absolute): no page uses a term the ramp hasn't introduced by that page's
position in the reading order, unless the term links to its defining page (or the
glossary anchor) at first use on that page.** The nav order *is* the reading order:
Getting Started → Concepts (in file order) → Guides → Reference. Reference and Guides
pages may use any ramp term (they sit after the whole ramp) but still link on first use.
A newcomer must never hit "the outbox drains the projection" cold.

Plain-English definitions below are **the** definitions — reuse them verbatim (or
tighter) at the defining site, and don't re-define elsewhere (link instead).

| # | Term | First defined | Plain-English definition to use |
|---|---|---|---|
| R1 | **agent** (durable agent) | Landing / Introduction | An AI agent that keeps working — and keeps its memory — across process restarts, deploys, and crashes. |
| R2 | **gateway** | Introduction (light), Installation (operational) | The single front door. Your app, your UI, and the CLI talk to teaspill only through the gateway. |
| R3 | **durable execution** | Concepts: Durable agents & the wake model | A way of running code as a journal of recorded steps: if the process dies, the run resumes from the last completed step instead of starting over. teaspill gets this from Restate. |
| R4 | **virtual object / single-writer** | Concepts: Durable agents & the wake model (informally: "each agent is one object that processes one thing at a time"); formalized in the Restate primer | A named, addressable unit with its own state that handles one invocation at a time. Every teaspill agent is one; "single-writer" means nothing else can mutate its state concurrently, which is what makes its event ordering trustworthy. |
| R5 | **wake** | Concepts: Durable agents & the wake model | One turn of an agent's life. A message, a child finishing, or a timer wakes the agent; it does some work (maybe calls the model, maybe spawns children), then goes back to sleep. Agents never block or poll — anything they're waiting for arrives as a later wake. |
| R6 | **entity / entity URL** | Concepts: Entities & addressing | Each running agent is an *entity* with a stable URL-shaped id (`/t/default/a/researcher/01j…`) used everywhere: in the catalog, in events, in the API. |
| R7 | **timeline / canonical event** | Concepts: Timelines & events | The append-only record of everything an entity does — messages, tool calls, results, lifecycle markers — as numbered events (`seq` 0, 1, 2, … with no gaps). The timeline is history you can read and replay; the platform never reads it to decide what to do next. |
| R8 | **token delta** | Concepts: Timelines & events | The live, streaming fragments of a message while the model is still producing it. Deltas ride a sibling stream, are droppable, and are always superseded by the finalized event on the timeline. |
| R9 | **projection / outbox** | Concepts: Projections & the catalog | The one-way flow that copies what agents do out to the places you read from (the timeline stream, the catalog). "Outbox" is the mechanism that makes that copy exactly-once; you'll only care about the name if you work on teaspill itself. |
| R10 | **catalog** | Concepts: Projections & the catalog | The Postgres registry of every entity — type, status, parent, tags — that your UI subscribes to as live-updating queries (via Electric). Lists and dashboards come from the catalog; conversation detail comes from timelines. |
| R11 | **snapshot / fast-join** | Concepts: Timelines & events (snapshot), expanded in Frontend guide | A periodic event that carries the entity's complete state at that point, so a UI can join a long timeline at the latest snapshot and fold forward, instead of replaying from event 0. |
| R12 | **workspace / executor** | Concepts: Workspaces & execution | A workspace is the sandboxed environment (filesystem + shell) an agent's tools run in, chosen when the agent is spawned. The executor is the service plane that hosts workspaces; it scales independently of the agents themselves. |
| R13 | **harness** | Concepts: Harnesses | The engine that runs the model loop inside a wake. You pick one per agent: the native harness (teaspill owns the loop, any provider) or the Claude Agent SDK harness (Claude Code semantics). Swapping harnesses changes nothing else about the agent. |
| R14 | **control verb** | Concepts: Lifecycle & control | The four outside interventions: `interrupt`, `pause`, `resume`, `archive`. Everything else you want to tell an agent is just a message. |
| R15 | **archive / resurrection** | Concepts: Lifecycle & control | An idle agent archives: its state is stored in the catalog and it stops costing anything. Sending to an archived agent resurrects it — same identity, same timeline, seq counter continues. |
| R16 | **steer** | Concepts: Lifecycle & control (with multi-agent patterns cross-link) | Injecting a message into an agent's *current* run mid-turn instead of queueing a new wake; degrades to a normal message if the agent isn't mid-turn. |

Notes for authors:
- Getting Started may **use R1/R2 fully** and may *preview* later terms (the quick start
  will show a timeline in the browser) — every preview links to the defining concept
  page. The architecture overview (last Getting Started page) may name R3–R13 as a
  guided map, each linked; it defines none of them.
- "Restate" itself is introduced in the Introduction as one sentence ("built on Restate,
  an open-source durable-execution engine — you don't need to know it to use teaspill")
  and taught in the primer.
- Internal-only vocabulary that must NOT appear on public pages at all: steerbox, seam,
  K/V (say "the agent's durable state"), `ctx.run`, journal budget, A1/A6-style ids,
  "single-writer" outside its defining sentence and contributor pages, producer
  epoch/offset, drift classes (`catalog_lag`, `stuck_outbox`), "wake registry".
  Exception: Concepts pages *teaching* the mechanism may use "journaled" once, defined
  inline; Contributing pages may use any of it.
- The **history-hole** notion (recovery snapshot after catastrophic stream loss) is
  taught only in the Frontend guide + Backup & restore, defined at first use ("a marked
  gap: the timeline says 'history is missing here' instead of pretending otherwise").

## 5. The expandable-context pattern (D4)

**Component: a single-item `::accordion`.** (Verified against the installed template:
prose components are `accordion`/`accordion-item`, `callout`, `note`/`tip`/`warning`/
`caution`, `tabs`, `steps`, `code-group`, `code-collapse` — there is no standalone
`::collapse` prose component; `code-collapse` is for long code only.)

Canonical form:

```mdc
::accordion
  :::accordion-item{label="Why the timeline is never read for control flow" icon="i-lucide-microscope"}
  The precise version, as long as it needs to be. Full sentences, may include code,
  may cite mechanisms by their real names (outbox, idempotent producer).
  :::
::
```

Rules:
1. **When to use it:** wherever the internal docs would have said "see <decision/task id>"
   or leaned on an internal doc filename; and wherever a "Roughly:" simplification needs
   its precise counterpart. Fuller background goes in the accordion; the page's own prose
   must stay complete and true *without* expanding it — never hide a load-bearing fact
   (anything the reader needs to use the feature correctly) inside one.
2. **The summary line** is the `label`: plain language, ≤ 12 words, either an implicit
   question the curious reader has ("Why sha256 and not bcrypt?") or an
   "Under the hood: …" phrase. Never "Details", never "Advanced", never an id.
3. Standard icon: `i-lucide-microscope` for under-the-hood background,
   `i-lucide-history` for design-rationale/history. Keep to these two.
4. At most **two** accordions per page. If you want a third, the material belongs on a
   Contributing page or nowhere.
5. Accordion bodies still obey the public-voice ban list (§6) — depth ≠ internal ids.

**Worked example — converting a real internal cross-reference.**

Internal source (`docs/frontend-sdk.md`, "Seq idempotency (A6)"):

> Records dedup by embedded canonical `seq`: a record with `seq <= appliedThroughSeq`
> is **dropped** (counted, not drift). This absorbs the durable-streams server's
> debounced-producer-checkpoint readmission window — a server crash can readmit an
> already-acked append as a same-seq duplicate stream record, so **readers must dedup
> by `seq`**.

Public rewrite (Frontend integration guide):

```mdc
The reducer deduplicates by event number: if a record arrives with a `seq` it has
already applied, it is dropped and counted — duplicates are normal, not an error.
You never need to handle them yourself.

::accordion
  :::accordion-item{label="Where duplicate events come from" icon="i-lucide-microscope"}
  The streams server persists its writer-dedup state on a debounce. If the server
  crashes inside that window, an append it already acknowledged can be re-admitted
  after restart, so the same event can appear twice in a read — byte-identical, with
  the same `seq`. Because every event embeds its `seq`, dropping the second copy is
  always safe, and the reducer does it for you. A *gap* in `seq`, by contrast, is
  never normal: the reducer surfaces it as drift (see below).
  :::
::
```

What changed: the decision id vanished; the claim the reader needs ("duplicates are
normal, handled for you") stayed in the prose; the mechanism moved into the accordion
under a plain-language label; the internal jargon ("debounced-producer-checkpoint
readmission window") was unpacked into sentences.

**The one sanctioned exception (D4):** Contributing pages may link to design history.
Exact wording rule: at most one such pointer per page, phrased as
"teaspill's full design history — every architectural decision and why — lives in the
repository under [`work/`](https://github.com/<org>/<repo>/tree/main/work) (start with
`work/README.md`)", pointing at the directory or `work/README.md`, never at an
individual decision or task; never used in place of an explanation the page itself
owes the reader. No other page family may reference `work/` in any form.

## 6. Public-voice ban list (grep-audited at T4.2)

Zero occurrences outside the Contributing exception above:

- Task/decision/amendment ids: `T\d+\.\d+`, `\b[DAR]\d+\b` in id position, `0001:`,
  `0002:`, `0003:`, "Gate \d", "Wave \d", "SPIKE".
- `work/plans`, `WORKLOG`, `DECISIONS.md`, `PLAN.md`, `INDEX.md`.
- Internal doc filenames: `docs/addressing.md`, `casdk-mapping.md`,
  `differences-from-electric-agents.md`, `schema-reference.md`, etc. (link to site pages
  instead).
- The competitor framing: "electric agents", "electric.ax", "upstream bugs", "rebuild of".
  (Using **Electric** the sync engine by name is required and fine — it's a dependency.)
- Ledger/process words used as vocabulary: "frozen at gate", "per the plan",
  "the executor of this task".

## 7. Glossary page spec

- **Location:** `content/2.concepts/10.glossary.md` (last Concepts page; owned by T3.2).
  Title: "Glossary". Icon: `i-lucide-book-a`.
- **Opening:** one sentence + a "learning path" note: "Terms are listed alphabetically;
  if you're new, read the Concepts section in order instead — it introduces each of
  these when you need it."
- **Entries:** every R-term from §4 plus: Electric, Restate, durable streams (the
  history store), spawn, `child_finished`, seq, drift, history hole, read token,
  API key, tenant, revision (state schema), summarization, `opaque` event.
  Alphabetical order. Each entry: **bold term** — 1–3 sentence definition (reuse §4
  wording) — "→ Defined in [page]" link to the defining page/section.
- **Anchors:** each term is a `##`-level heading so `…/concepts/glossary#wake` deep
  links work; ramp-rule links from other pages may target either the defining page or
  the glossary anchor.
- No code blocks, no accordions, no images. Target ≤ 1,200 words.
- Maintenance rule: any T3.x page that introduces a genuinely new term must add its
  glossary entry in the same task (same content dir ownership doesn't apply to the
  glossary — Wave 2 tasks append entries via their own WORKLOG note for T4.2 to verify;
  in practice §4 already covers the expected vocabulary).

## 8. What we borrow from each reference page (the citation ledger)

| Reference | Borrowed trait |
|---|---|
| nuxt.com/docs/4.x/getting-started/introduction | Concept-pitch page with zero code; "Read more in …" progressive-disclosure links; short declaratives for positioning ("Nuxt has no vendor lock-in"). |
| nuxt.com/docs/4.x/getting-started/installation | Prereq bullets with versions; create → enter → run sequencing; explicit success checkpoint ("Well done! A browser window should open…"); one-link forward close. |
| nuxt.com/docs/4.x/getting-started/data-fetching | The tiered "in a nutshell" ranking of alternatives; trade-offs framed contextually instead of prescriptive rules; warnings placed on anti-patterns. |
| nuxt.com/docs/4.x/guide/directory-structure/app/pages | Reference-entry pattern: convention → file-tree/code example → resulting behavior, identical per entry; instructional-conversational tone in reference material. |
| nuxt.com/docs/4.x/getting-started/routing | The hub page: per section 2–4 sentences + ≤ 15 lines of code + a delegating link; the whole page stays short. |
| laravel.com/docs/13.x/routing | Flat anchor mini-TOC; claim sentence → copy-pasteable block → variations, repeated; plain-noun section names. |
| laravel.com/docs/13.x/validation | Quickstart walkthrough *before* the rulebook on long pages; the "claim → code" formula sustained across dozens of entries; "you may…" second person. |
| laravel.com/docs/13.x/queues | Problem-first opening; distinction-callouts placed exactly where confusion arises ("connections vs queues"); one running example progressively decorated. |

## 9. Verification duties for content agents

- **Verify every technical claim against the current code, not the internal doc** —
  several internal docs/READMEs lag. Known stale spots found during T2.1 (assume there
  are more):
  1. `packages/cli/README.md` omits `teaspill keys` — the command exists
     (`packages/cli/src/cli.ts`, `src/commands/keys.ts`). Derive the CLI reference from
     `cli.ts`, not the README.
  2. `packages/gateway/README.md` "Minting a key today (CLI ergonomics land in T6.2)"
     + manual-SQL snippet is stale; `docs/auth.md` + `@teaspill/catalog`
     (`createApiKey`/`newApiKey`/`hashApiKey`) is current.
  3. `packages/schema/README.md` and `packages/harness-native/README.md` still say
     "STATUS: PROPOSED, not frozen" — the schema is frozen v1; never repeat "proposed".
  4. `packages/conformance/README.md` says ready-made conformance agents are "not yet
     shipped" — stale; `packages/reference-deployment` ships them.
  5. `packages/conformance/README.md` and `packages/chaos/README.md` examples use
     `TEASPILL_STACK_URL=http://localhost:8080` — the gateway's default port is **8787**
     (8080 is Restate ingress). Re-verify before citing any URL.
  6. `docs/frontend-sdk.md` shows `fromSnapshot: { seq }` only; the current option is
     `fromSnapshot: { seq, offset? }` (`packages/frontend-sdk/src/timeline.ts`), with
     the stream offset coming from the catalog's `snapshot_stream_offset`.
  7. Addressing helpers now live in `@teaspill/schema` (`src/addressing.ts`) — cite that
     as the public home (the gateway still carries a private copy; irrelevant to docs).
- Run every command/code block in the quick start and guides against the current repo
  (Wave 2) or against the package APIs by typechecking a scratch file (Wave 1).
- When code contradicts an inherited architectural decision: stop and escalate (it's a
  bug on one side); never paper over it in prose.
