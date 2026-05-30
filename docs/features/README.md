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

## The three buckets

```
docs/features/
├─ public/         # what the user experiences — also feeds the marketing site
├─ concepts/       # principles & patterns we uphold, usually ~1:1 with an invariant
└─ architecture/   # concrete subsystems and how they're built
```

- **`public/`** — anything a user can see or interact with: the configurable sidebar,
  AI and non-AI scratchpads, end-to-end-encrypted scratchpads, message sharing. Written
  for someone who wants to understand what the product _does_.
- **`concepts/`** — a principle, pattern, or invariant we uphold, described abstractly:
  subscribe-then-bootstrap, workspace-as-shard-boundary (INV-8). A concept isn't tied to
  one component — it says _what guarantee we keep and why_, then points to the subsystem(s)
  that implement it. Usually ~1:1 with an INV-\*.
- **`architecture/`** — a concrete subsystem and how it's actually built: the sync engine,
  the outbox dispatcher, the worker runtime. Has files, a lifecycle, edge cases. This is
  where the implementation depth lives.

The line between the last two: if you could rewrite the implementation without touching the
doc, it was a concept doc; if the doc names files and would drift when they move, it's an
architecture doc. When a concept has a meaty implementation, write both and link them with
`related:` — the concept stays lean, the subsystem carries the depth (subscribe-then-bootstrap

- sync-engine are the worked example). A small pattern whose concept and implementation are
  inseparable can stay a single architecture doc (the outbox is one).

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

### `concepts/` docs

```yaml
---
title: Subscribe-Then-Bootstrap
status: shipped
audience: internal
kind: concept # distinguishes concept from subsystem docs
invariants: [INV-53] # the invariant(s) this principle is
public_site: false
summary: >
  Confirm your subscription before fetching the snapshot, then reconcile the overlap.
related: [architecture/sync-engine.md] # the subsystem(s) that implement it
---
```

A concept doc has no `entry_points` — it isn't tied to files. It points to its
implementations through `related:` instead.

### `architecture/` docs

```yaml
---
title: Outbox Pattern
status: shipped # planned | building | shipped
audience: internal
kind: subsystem # distinguishes subsystem from concept docs
invariants: [INV-4, INV-6, INV-7] # the invariants this mechanism enforces
entry_points: # canonical files to open when working on it
  - packages/backend-common/src/outbox/dispatcher.ts
  - packages/backend-common/src/outbox/cursor-lock.ts
public_site: false
summary: >
  Domain writes and their real-time events commit in one transaction; a dispatcher
  fans them out to Socket.io with gap-safe, at-least-once delivery.
related: [architecture/sync-engine.md]
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

**`concepts/` docs:** state the principle, not the code. Stay at the level where it would
still be true if we rewrote the implementation.

- `## The principle` — the rule, in one or two sentences, then a short expansion.
- `## The race / problem it prevents` — why the naive approach is wrong.
- `## What an implementation must do` — the checklist any implementer must satisfy.
- `## How Threa implements it` — a pointer to the architecture doc(s), not the detail.
- `## Invariants` — the INV-\* this concept _is_.

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
- `## Correct / incorrect usage` — optional, when there's a foot-gun worth showing as
  code (the right call next to the tempting wrong one).

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
- `concepts/subscribe-then-bootstrap.md` — a principle (INV-53), pointing to its subsystem.
- `architecture/sync-engine.md` — the subsystem that implements that principle.
- `architecture/outbox-pattern.md` — a self-contained pattern + its one implementation.

Once the shape is approved, the follow-on work is: backfill docs for the other shipped
features, wire the Astro content collection in the public-site worktree, update the
`create-pr` / `code-review` / `sync-plan` skills, and remove the committed plans.
