---
name: build-feature
description: Build a ratified plan as a stacked PR chain — per-chunk Opus-low implement, Opus-high adversarial verify, gh-stack PR, Opus-low PR review, bounded fixes, and a final whole-stack adversarial pass. Use when asked to /build-feature or to build out a plan as stacked PRs.
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

Reasoning effort is settable **only** through `Workflow`'s `agent(prompt, { effort })`; a plain `Agent` call inherits session effort and silently ignores the intent. So each chunk runs as two `Workflow` invocations — steps 2–4, then step 6 — with the orchestrator doing git, gh-stack, and PR creation in between, because workflow scripts have no shell or filesystem access.

Two children concurrent at most; a child never delegates. Put StructuredOutput schemas on verifiers and fixers only — implementers report free text (Opus implementers reliably mangle StructuredOutput after a long file-writing run, and the work is usually already on disk).

### Pi / OpenAI profile

Only when the harness is Pi, not Claude. Planner and verifier: GPT-5.6 Sol `high`. Implementer: Sol `low` (request `low` explicitly — Pi maps Sol `minimal` to provider `low`). Whole-stack: Sol `high`, or one `xhigh` pass when the stack crosses security, authorization, migration, concurrency, or data-integrity boundaries. No external second-model pass — Sol already implemented and reviewed. Follow root `AGENTS.md` read-efficiency rules. Everything else on this page applies unchanged.

## Plan first

- Build only from a plan with an explicit PR-stack breakdown: each chunk is one PR with deliverables, enumerated tests, exclusions, and its base branch. A chat message is not a plan.
- No plan → dispatch one planner to investigate and draft it. Publish the plan to Seer and share the URL; embed it in each PR body with `/sync-plan`. Files under `docs/plans/` are desired-design context, never implementation truth.
- Start building as soon as the plan is published — no ratification round-trip — unless the plan contains a stop-class decision (schema migration, public API contract, data deletion, anything hard to reverse) or the user asked for a checkpoint. Then wait.
- Deferred items in the plan are binding: do not build them.

## Per chunk

1. **Brief** — write `.tmp/build-feature-<chunk>-brief.md`: binding plan sections, deliverables, neighbor files to imitate, enumerated tests, what NOT to build, exact `base_ref`. Agents get the path, never a pasted wall.
2. **Implement** — one implementer in the chunk's working tree, no commits. Then run the brief's typecheck/tests yourself and read the diff.
3. **Adversarially verify** — one verifier, given the brief, the diff path, and the gate summary. It re-derives behavior from the diff rather than trusting the implementer's report, walks the race and edge paths the plan names, and checks reuse (INV-35/37): name the existing abstraction a duplicate should collapse into. It reports only concrete findings with a failure scenario, self-scored ≥80. It does not rerun green suites.
4. **Triage and fix** — one disposition per finding (below), one batched fix pass, one targeted recheck. Then save the reviewed patch: `{ git diff "$base_ref"...HEAD; git diff HEAD; } > .tmp/build-feature-<chunk>.diff`, with dispositions and gate outcomes in `.tmp/build-feature-<chunk>-evidence.md`.
5. **Stack the PR** — `/commit`, then `gh stack add <branch>` and `/create-pr`; each chunk branches off the previous chunk, the first off `origin/main`. `/create-pr` owns `gh stack submit --auto`. **Confirm `gh stack view --json` reports a `Stack #NNNN` before continuing.** Chained-base PRs without a Stack are a failed step, not a variant — retrofit with `gh stack submit --auto --open`. Read the `gh-stack` skill before your first stack command this session; this list is a memory jog, not the contract.
6. **Review the PR** — one PR reviewer runs `/code-review <PR#>` (PR mode posts the report as a comment). Triage its findings the same way, fix accepted ones in one batch, push. Do not wait on CodeRabbit here; its threads get swept once at the whole-stack stage.

## Triage is yours

Every finding from every reviewer gets exactly one disposition, recorded in the chunk's evidence file:

- **Accept** — real, in scope; fix it in this chunk.
- **Refute** — wrong; write the one-line evidence (code path, test, invariant id). Refuting with evidence is expected and healthy; blind fixes have caused real regressions here.
- **Defer** — real but outside the ratified scope; note it in the PR body and carry it into the whole-stack review.

Reviewers advise; you decide. A refuted finding does not get a rematch in a later pass.

## Don't spiral

- One batched fix pass per review pass — all accepted findings at once, never one at a time.
- The recheck sees only the accepted findings and the lines changed for them. It may report exactly two things: an accepted finding that isn't actually fixed, and a regression the fix introduced. Anything else is out of bounds — discard it, no matter how interesting.
- At most one surgical round after that recheck. Then the gate is closed for this diff revision.
- A fresh broad review pass only when the diff changed materially for a reason other than remediating findings.
- **Tripwire:** two consecutive rounds touching the same lines without the accepted-blocker count dropping means you are spiralling. Stop, report the state, ask.
- Gates run in the orchestrator: once after implement, once after the fix batch, then only affected gates. Reviewers get the summary and do not rerun green suites.

## Don't stall

Keep going. None of these is a reason to stop, hand back, or split the chunk:

- Red gates you haven't yet tried to fix; a failed, timed-out, or truncated child. Check `git status` first — the work is usually already on disk. Preserve it, resume or replace the agent. **A dead child is not a consumed fix round.**
- A reviewer you disagree with → refute with evidence and move on.
- The chunk is bigger or messier than the plan implied but stays inside its ownership boundary → build it.
- Missing optional credentials, no live smoke path, behavior unverifiable locally → use a deterministic substitute, record the caveat in the PR body.
- Minor or deferred findings that survived the cap → PR body known-issues section, continue.
- Pre-existing failures you surfaced → fix them in-branch (INV-22).

Stop and ask only for: a blocker surviving the round cap; the spiral tripwire; a plan change touching schema, public contract, or deletion; the same failure signature twice with no new hypothesis; or concrete evidence the chunk must coordinate a second independently-owned lifecycle or state machine — then preserve the patch and propose a split along that boundary. Chunk size alone is not that evidence.

## After the last chunk

7. **Whole-stack adversarial review** — one reviewer over `git diff origin/main...<tip>`: cross-PR seams, invariants invisible inside one chunk, and plan conformance — every ratified chunk built, nothing deferred smuggled in, PR bodies and `/sync-plan` blocks matching what actually shipped.
8. **Stack hygiene** — `gh stack view --json` shows every PR linked; `gh stack sync --prune` if `main` moved; CI green; every CodeRabbit thread dispositioned via `/respond-to-pr-review`.
9. **UI features** — throwaway Playwright pass against the e2e stack: screenshots at 1440px and 390px, scroll inner containers (fullPage misses them), read the PNGs, delete the spec.
10. Fold accepted findings in one batch under the same bounds, run affected gates, push, and report the per-PR links. No second external model unless the user asks.

## Gotchas

- `Workflow` `args` must be real JSON values, not a stringified blob; briefs go in files.
- Stacked PRs run the main CI trio only when targeting `main` — run required gates locally before submitting.
- Merge and sync through `gh stack` only; never hand-roll rebases around squash merges.
- Pre-commit runs full monorepo lint + typecheck: generous timeouts, and fresh worktrees need `bun install` first.
- Scout `gh pr list` for open PRs touching the same files before starting — a mid-build collision costs a squash and rebase.
