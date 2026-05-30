# Feature Documentation

This tree describes Threa's features **as they actually exist in the code today** —
present tense, behavioral, kept current as features change.

It is deliberately the opposite of a plan. A plan describes the feature we _wanted_,
frozen at design time, and it rots the moment implementation diverges. A feature doc
describes the feature we _have_. If the code changes and the doc doesn't, the doc is a
bug — and that is the point: it gives us a single, trustworthy reference for how each
feature is meant to behave.

## Why this exists

Two payoffs, one source of truth:

1. **Agents and engineers work against intent, not guesswork.** When someone (human or
   agent) touches the sidebar, they read `public/configurable-sidebar.md` for the
   intended behavior and `architecture/*.md` for the mechanics, instead of
   reverse-engineering it from scattered code or trusting a stale plan.

2. **The marketing site stays honest and current.** Public feature docs carry
   machine-readable frontmatter. The public site (Astro, separate worktree) reads
   `public/*.md` directly as a content collection, so "update the website" becomes "the
   build reads the same files we already keep current" — not a brittle scrape, and never
   a fictional mechanic (we document what ships, per the no-fiction-in-sales rule).

## The two sides

```
docs/features/
├─ public/         # user-facing behavior — also feeds the marketing site
└─ architecture/   # how it works internally — feeds agents + engineers
```

- **`public/`** — anything a user can see or interact with: the configurable sidebar,
  AI and non-AI scratchpads, end-to-end-encrypted scratchpads, message sharing. Written
  for someone who wants to understand what the product _does_.
- **`architecture/`** — recurring patterns and internal mechanisms: the outbox pattern,
  subscribe-then-bootstrap, the worker runtime. Written for someone who needs to change
  the system correctly. These usually anchor to one or more invariants (INV-\*).

When a feature has both a user-facing surface and non-obvious mechanics, write **both**
and cross-link them with `related:`.

## What this is NOT

- Not a replacement for `docs/architecture.md`, `docs/system-overview.md`, or
  `docs/core-concepts.md`. Those are system-level references. Feature docs are
  **per-feature** and have a lifecycle (added when a feature lands, updated when it
  changes).
- Not a plan. No "we will", no "phase 2", no aspirations. If it isn't built, it doesn't
  go here (use `status: building` for partially-shipped features and describe only what
  exists).
- Not a changelog. Describe the current behavior, not the history of how it got there
  (INV-25).

## Frontmatter schema

Every doc starts with YAML frontmatter. The site collection validates it against this
schema, so keep field names exact.

### `public/` docs

```yaml
---
title: Configurable Sidebar # human title
status: shipped # planned | building | shipped
audience: public
since: 2026-05 # YYYY-MM the feature first shipped
surfaces: [sidebar, labels-page] # UI areas the feature touches
public_site: true # site picks up docs where this is true
summary: > # one plain sentence for the site (no hype)
  Group your streams into reorderable sections — smart buckets, stream types, or
  labels — each an independent filter.
related: [architecture/outbox-pattern.md] # optional cross-links
---
```

### `architecture/` docs

```yaml
---
title: Outbox Pattern
status: shipped # planned | building | shipped
audience: internal
invariants: [INV-4, INV-6, INV-7] # the invariants this mechanism enforces
entry_points: # canonical files to open when working on it
  - packages/backend-common/src/outbox/dispatcher.ts
  - packages/backend-common/src/outbox/cursor-lock.ts
public_site: false
summary: >
  Domain writes and their real-time events commit in one transaction; a dispatcher
  fans them out to Socket.io with gap-safe, at-least-once delivery.
related: [public/configurable-sidebar.md]
---
```

`status` values:

- **`planned`** — reserved; generally a feature shouldn't get a doc until it's at least
  partially built. Avoid unless you have a reason.
- **`building`** — partially shipped. Describe only what exists today; note the gaps in
  a `## Boundaries` section.
- **`shipped`** — live in production.

## Document structure

Keep headings consistent so the docs are skimmable and the site can render them
predictably.

**`public/` docs:**

- `## What it does` — plain description of the behavior.
- `## How a user experiences it` — the surfaces and interactions.
- `## Boundaries` — what it deliberately does _not_ do (display-only, deferred bits).
- `## Related` — optional links.

**`architecture/` docs:** write the top the way you'd explain it to a colleague at a
whiteboard, then drop into reference depth lower down. Keep the precise details (config
values, ordering subtleties, file paths) — just don't make them the first thing a reader
wades through, or the mental model never lands.

- `## The gist` — what it is and why it's worth it, in plain prose. The mental model
  lands here, before any mechanism.
- `## How it works` — the core mechanism, with cited files. End with a line telling a
  reader who only wants the model that they can stop here.
- `## Details worth knowing` — the reference layer: edge cases, ordering subtleties,
  config like pool sizes. Optional, but this is where precision lives once the reader has
  the shape.
- `## Invariants` — the INV-\* IDs it enforces.
- `## Entry points` — canonical files to open (mirrors frontmatter).
- `## Correct / incorrect usage` — optional, when there's a foot-gun (see
  `architecture/subscribe-then-bootstrap.md`).

## How these stay current (the crux)

A feature doc that isn't updated is worse than none. Currency is enforced at the moment
a feature lands, replacing the old committed-plan step rather than adding a parallel
chore:

- **A feature PR updates its feature doc** in the same PR. New feature → new doc;
  changed behavior → edited doc. The `create-pr` and `code-review` skills check for this.
- **Greptile reviews the diff against the feature doc**, not a stale plan. Because the
  doc is present-tense and accurate, design-adherence review actually means something.
- **Plans become transient scratch.** Plans are still useful while _building_ — they're
  just not committed artifacts. They live as local agent state and are gitignored. The
  durable record is the feature doc.

> Migration status: the move off committed plans (`docs/plans/`, `.claude/plans/`) and
> the skill rewiring (`sync-plan` → feature-doc sync) is a separate, larger change. It
> is **not** done yet — see the pilot rollout note below.

## Rollout

This started as a pilot:

- `public/configurable-sidebar.md` — a shipped user-facing feature.
- `architecture/outbox-pattern.md` — a core internal pattern.
- (moved here) `architecture/subscribe-then-bootstrap.md` — was `docs/frontend/`.

Once the shape is approved, the follow-on work is: backfill docs for the other shipped
features, wire the Astro content collection in the public-site worktree, update the
`create-pr` / `code-review` / `sync-plan` skills, and remove the committed plans.
