---
name: build-feature
description: Build a planned feature as a stacked PR chain — per-chunk Opus-low implement, Opus-high adversarial verify, gh-stack PR, Opus-low PR review, bounded fixes, and a final whole-stack adversarial pass. Use when asked to /build-feature or to build out a plan as stacked PRs.
---

# Build a feature as a reviewed stacked-PR chain

One chunk at a time: implement, adversarially verify, fix, stack the PR, review the PR, fix, next chunk. Then one adversarial pass over the whole stack.

Slow is fine — the run is allowed to take hours. Two failure modes are not: reviewing your own fixes in circles until quota dies, and stopping at the first hindrance with nothing shipped. Every bound below exists to block one of those two.

## Agents and effort

Claude default is Opus at every layer. **Use Fable only when the user names it.**

| Role | Model / effort | Owns |
| --- | --- | --- |
| Orchestrator | you, current session effort | sequencing, git, gh-stack, triage, gates, checkpoints |
| Planner | Opus `high`, one fresh agent | plan + PR-stack breakdown; never implements, never delegates |
| Implementer | Opus `low` | one chunk's diff, in the working tree, no commits |
| Adversarial verifier | Opus `high` | correctness, races, edge paths, plan conformance |
| PR reviewer | Opus `low`, `agentType: 'general-purpose'` | runs `/code-review <PR#>` on the opened PR |
| Whole-stack reviewer | Opus `high` | cross-PR seams, plan conformance, stack hygiene |

Reasoning effort is settable **only** through `Workflow`'s `agent(prompt, { model, effort, agentType })`; a plain `Agent` call inherits session effort and silently ignores the intent. Every dispatch on this page is therefore a `Workflow` invocation, including the single-agent ones (planner, whole-stack reviewer). Each chunk is two of them — steps 2–4, then step 6 — with the orchestrator doing git, `gh stack`, and PR creation in between, because workflow scripts have no shell or filesystem access.

A child never delegates, with one exception: `/code-review` fans out to its own Sonnet lenses. That is the tool's design, not a violation — the PR reviewer's Opus `low` buys triage and skill orchestration, not the review lenses themselves.

Put StructuredOutput schemas on verifiers and fixers only — implementers report free text (Opus implementers reliably mangle StructuredOutput after a long file-writing run, and the work is usually already on disk).

### Pi / OpenAI profile

Only when the harness is Pi, not Claude. Planner and verifier: GPT-5.6 Sol `high`. Implementer: Sol `low` (request `low` explicitly — Pi maps Sol `minimal` to provider `low`). Whole-stack: Sol `high`, or one `xhigh` pass when the stack crosses security, authorization, migration, concurrency, or data-integrity boundaries. Two children concurrent at most. No external second-model pass — Sol already implemented and reviewed. Follow root `AGENTS.md` read-efficiency rules. Everything else on this page applies unchanged.

## Plan first

- Build only from a plan with an explicit PR-stack breakdown: each chunk is one PR with deliverables, enumerated tests, exclusions, and its base branch. A chat message is not a plan.
- No plan → dispatch one planner to investigate and draft it. Publish the plan to Seer and share the URL; embed it in each PR body with `/sync-plan`. Files under `docs/plans/` are desired-design context, never implementation truth.
- Start building as soon as the plan is published. No ratification round-trip: the user asked for a plan and a stack, not for a quiz. Wait only if the user asked for a checkpoint, or the plan requires a decision that cannot be undone by reverting the PRs — dropping or rewriting production data, a breaking public API change, deleting a user-facing surface. Append-only migrations, new tables, new endpoints, and feature-flagged rollouts are routine here (INV-17, INV-67): build them.
- Deferred items in the plan are binding: do not build them.

## Per chunk

1. **Brief** — write `.tmp/build-feature-<chunk>-brief.md`: binding plan sections, deliverables, neighbor files to imitate, enumerated tests, what NOT to build, exact `base_ref`. Agents get the path, never a pasted wall.
2. **Implement** — one implementer in the chunk's working tree, no commits. Then run the brief's typecheck/tests yourself and read the diff.
3. **Adversarially verify** — one verifier, given the brief, the diff path, and the gate summary. It re-derives behavior from the diff rather than trusting the implementer's report, walks the race and edge paths the plan names, and checks reuse (INV-35/37): name the existing abstraction a duplicate should collapse into. It reports only concrete findings with a failure scenario, self-scored ≥80. It does not rerun green suites.
4. **Triage and fix** — one disposition per finding (below), one batched fix pass, one targeted recheck. Then save the reviewed patch to the exact paths `/create-pr` looks for, or it will re-audit the diff and fire its own `/code-review`: `{ git diff "$base_ref"...HEAD; git diff HEAD; } > .tmp/build-feature-reviewed.diff`, with `base_ref`, dispositions, and gate outcomes in `.tmp/build-feature-review-evidence.md`. Both are per-chunk scratch; overwrite them each chunk.
5. **Stack the PR** — read the `gh-stack` skill before your first stack command this session; the order below is a memory jog, not the contract.
   - `gh stack add <branch>` **before** `/commit` — `add` creates and switches to the branch, carrying the uncommitted work with it. Commit first and the chunk's diff lands on the previous chunk's branch and its PR.
   - First chunk of a new stack: `gh stack init <branch>` (with `git config rerere.enabled true` and `remote.pushDefault origin` once), not `add` — `add` outside a stack exits 2, and `/create-pr` then silently opens an unstacked PR against `main`.
   - Then `/commit`, then `/create-pr`, which owns `gh stack submit --auto`.
   - Confirm before continuing. After chunk 1: `gh stack view --json` lists the branch and the PR's base is `main`. A GitHub Stack object needs two PRs, so `Stack #NNNN` cannot exist yet and its absence means nothing here. **From chunk 2 on, `gh stack view --json` must report a `Stack #NNNN`** — chained-base PRs without one are a failed step, not a variant; retrofit with `gh stack submit --auto --open`.
6. **Review the PR** — one PR reviewer runs `/code-review <PR#>` (PR mode posts the report as a comment). Triage its findings, fix accepted ones in one batch, push. **One `/code-review` per PR, full stop** — it has no targeted mode, so a "confirmation" re-run is a fresh broad pass that will find new things forever. The pushed fix is covered by the whole-stack pass. Do not wait on CodeRabbit here; its threads get swept once at the whole-stack stage.

## Triage is yours

Every finding from every reviewer gets exactly one disposition, recorded in the chunk's evidence file:

- **Accept** — real, in scope; fix it in this chunk.
- **Refute** — wrong; write the one-line evidence (code path, test, invariant id). Refuting with evidence is expected and healthy; blind fixes have caused real regressions here.
- **Defer** — real but outside the plan's scope; note it in the PR body and carry it into the whole-stack review.

Reviewers advise; you decide. A refuted finding does not get a rematch in a later pass.

## Don't spiral

The chunk's budget is a count, not a vibe. **Two broad passes: step 3's adversarial verify and step 6's one `/code-review`. Three fix batches: the batched fix, the surgical fix, and the post-`/code-review` fix.** That is the whole allowance. A third broad pass or a fourth fix on the same diff is not authorized anywhere in this document.

- Each broad pass produces a finding set, frozen at triage. Nothing later adds to it, revives a refuted item, or imports unrelated scope.
- The recheck sees only the accepted findings and the lines changed for them. It may report exactly two things: an accepted finding that isn't actually fixed, and a regression the fix introduced. Anything else is out of bounds — discard it, no matter how interesting.
- An unplanned broad pass — anything beyond those two — only if the diff changed materially for a reason other than remediating findings: a scope addition, not a fix.
- **Tripwire:** if a fix round touches lines a previous round already touched and the accepted set is not strictly smaller than before, you are spiralling. Stop, report the state, ask.
- Gates run in the orchestrator: once after implement, once after the fix batch, then only affected gates. Reviewers get the summary and do not rerun green suites.

A **blocker** is a finding whose consequence is one of: a user sees a wrong result, data is lost or corrupted, authorization is bypassed, or a named plan deliverable is absent. Consequence, not category — every finding that reaches triage is a correctness claim, so "it's a correctness issue" does not make it a blocker. A survivor that is not a blocker is minor by definition: it goes to the PR body's known-issues section and the run continues. There is no third bucket.

## Don't stall

Keep going. None of these is a reason to stop, hand back, or split the chunk:

- A red gate. Fixing it is the job, not a reason to escalate. Keep trying genuinely different hypotheses; a repeat of a failure you already tried to fix the same way is not a new attempt. Escalate only after three distinct hypotheses have each failed, with all three written down.
- A failed, timed-out, or truncated child. Check `git status` first — the work is usually already on disk. Preserve it, resume or replace the agent. **A dead child is not a consumed fix round.**
- A reviewer you disagree with → refute with evidence and move on.
- The chunk is bigger or messier than the plan implied but stays inside its ownership boundary → build it.
- Missing optional credentials, no live smoke path, behavior unverifiable locally → use a deterministic substitute, record the caveat in the PR body.
- Minor or deferred findings that survived the budget → PR body known-issues section, continue.
- Pre-existing failures you surfaced → fix them in-branch (INV-22).

Stop and ask only for: a **blocker** surviving the chunk's fix budget; the spiral tripwire; three failed hypotheses on one gate; a mid-flight plan change that drops data, breaks a public contract, or removes a user-facing surface; or concrete evidence the chunk must coordinate a second independently-owned lifecycle or state machine — then preserve the patch and propose a split along that boundary. Chunk size alone is not that evidence. That list is closed. If the reason you want to stop is not on it, you are stalling; finish the chunk and put the concern in the PR body.

## After the last chunk

7. **Whole-stack adversarial review** — one reviewer over `git diff origin/main...<tip>`: cross-PR seams, invariants invisible inside one chunk, and plan conformance — every planned chunk built, nothing deferred smuggled in, PR bodies and `/sync-plan` blocks matching what actually shipped.
8. **Stack hygiene** — `gh stack view --json` shows every PR linked; `gh stack sync --prune` if `main` moved; CI green; every CodeRabbit thread dispositioned via `/respond-to-pr-review`.
9. **UI features** — throwaway Playwright pass against the e2e stack: screenshots at 1440px and 390px, scroll inner containers (fullPage misses them), read the PNGs, delete the spec.
10. **Fold findings into the PR that owns them**, not into the tip branch: `gh stack checkout <branch>` → fix → commit → `gh stack rebase --upstack` → `gh stack push`. A chunk-2 fix committed on the tip ships in chunk 5's PR and leaves the reviewed PR wrong. One batch, same budget as a chunk, run affected gates, then report the per-PR links. No second external model unless the user asks.

## Gotchas

- `Workflow` `args` must be real JSON values, not a stringified blob; briefs go in files.
- Stacked PRs run the main CI trio only when targeting `main` — run required gates locally before submitting.
- Merge and sync through `gh stack` only; never hand-roll rebases around squash merges.
- Pre-commit runs full monorepo lint + typecheck: generous timeouts, and fresh worktrees need `bun install` first.
- Scout `gh pr list` for open PRs touching the same files before starting — a mid-build collision costs a squash and rebase.
