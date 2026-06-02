---
name: document-feature
description: Write ONE feature doc from docs/features/INVENTORY.md, verified against the code, and open a small PR for it. Use when asked to "document <feature>", "fill in the feature doc for X", "do the next feature doc", "backfill feature docs", or when a remote agent is started with a feature name to document.
---

# Document Feature

Write exactly one feature doc per run, verified against the code, shipped as its own
small PR. The doc system's spec lives in `docs/features/README.md`; this skill is the
workflow for filling it in, one inventory row at a time.

## Input

- An inventory row name (`saved-messages`, `concepts/race-safe-writes`, etc.), or free
  text describing the feature.
- No argument: open `docs/features/INVENTORY.md` and pick the first undocumented row,
  preferring the backfill order suggested under "Open questions".

## Process

### 1. Load the spec and an exemplar

- Read `docs/features/README.md` in full: the three buckets, frontmatter schemas,
  document structure, and altitude rules. It is authoritative; this skill doesn't
  restate it.
- Read one existing doc in the target bucket as the exemplar:
  `public/configurable-sidebar.md`, `concepts/subscribe-then-bootstrap.md`, or
  `architecture/sync-engine.md`.

### 2. Verify against code (this is the whole point)

- The inventory one-liner and its "where to look" pointers are hints, not facts. The
  sweep that produced them has already been wrong at least once.
- `docs/plans/*` describes the feature we wanted, not the feature we have. Never source
  a claim from a plan.
- Explore the real implementation. A good cheap path: spawn an Explore agent asking for
  (a) current behavior with file:line citations and (b) an explicit list of what is
  absent or half-wired: TODO/FIXME markers, commented-out branches, sections that render
  but are never populated, flags that nothing sets.
- Decide `status` honestly. `shipped` only if it's fully wired end to end; `building` if
  anything user-visible is stubbed or backend-unbacked. If the user has said a feature is
  unfinished, that is authoritative over any code sweep.
- `public_site: true` only when the doc is in `public/` AND status is `shipped`. Building
  features stay off the marketing site.

### 3. Write the doc

- Path: `docs/features/<bucket>/<name>.md`. Frontmatter must match the README schema for
  that bucket exactly (concepts get no `entry_points`; architecture docs get
  `kind: subsystem`, concepts `kind: concept`).
- Structure per the README. Architecture docs read colleague-first: the gist, how it
  works, then a "Details worth knowing" reference layer, with an explicit "you can stop
  here" off-ramp. Concept docs state the principle at a level that would survive a
  rewrite. Public docs: what it does, how a user experiences it, boundaries.
- A Boundaries/Status section states plainly what does NOT exist. Honest gaps beat
  smooth overclaims; an unfinished edge described accurately is a feature of the doc.
- Tone: plain, casual, clear. Apply the deslopify skill's rules; at minimum
  `grep -c '—' <file>` must return 0, and no hype words or rhetorical flourishes.
- Watch markdown footguns: a `+` or `-` that wraps to line start becomes a list bullet
  and prettier will lock that in. Re-read after the pre-commit hook rewrites the file.

### 4. Wire it in

- `INVENTORY.md`: link the row's name to the new doc and append ✅ (plus
  "(building)" when applicable).
- Cross-link `related:` in both directions when a concept/subsystem/public pairing
  exists.
- If verification contradicted another feature doc or the inventory, fix that in the
  same PR and call it out. Drift discoveries are a deliverable, not a distraction.

### 5. Ship a small PR

- One doc per PR. Branch from a freshly fetched main:
  `git fetch origin main && git checkout -b docs/feature-<name> origin/main`.
- Commit as `docs(features): add <bucket>/<name>`, push, and open the PR with the
  `create-pr` skill. If `gh` is unavailable (web/remote session), fall back to the
  `github-api-web` skill.
- PR body, written to be read on a phone: what was verified and how, the status call and
  why, any drift discovered, and what was deliberately left out of scope.

## Guardrails

- Docs only. If verification surfaces a product bug, flag it in the PR body; don't fix
  code in this PR.
- One doc per run. If the chosen row turns out to be two docs (see the granularity
  notes in INVENTORY's open questions), write the narrower one and record the call in
  the PR body.
- Don't rewrite an existing doc unless verification proves it wrong; when it does, say
  exactly what was wrong and how you know.
