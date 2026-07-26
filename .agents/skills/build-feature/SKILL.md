---
name: build-feature
description: Build a planned feature as a stacked PR chain with bounded discovery, autonomous remediation, and runtime-specific Claude or Pi/OpenAI profiles.
---

# Build a feature as a reviewed stacked-PR chain

Build each ratified plan chunk, verify it once, remediate one immutable finding set, and create its stacked PR before moving on. Do not pay multiple agents to repeat the same review lens.

## Planning and launch

- The invoking agent remains the orchestrator at its current, lower reasoning level. It owns sequencing, briefs, gates, checkpoints, and stack state; it does not become the planner.
- Require a user-ratified implementation plan with a PR-stack breakdown. The plan embedded in the PR body by `/sync-plan` is authoritative. Files under `docs/plans/` are optional desired-design context, never implementation truth.
- No plan: delegate investigation and drafting to one fresh high-reasoning planner, obtain user ratification, then publish with `/sync-plan`. The planner never orchestrates implementation or delegates children. Do not build from an unratified chat message.
- Deferred items are immutable and out of scope.
- At launch, record the selected runtime profile and operating mode. Phrases such as “overnight,” “AFK,” “workflow owns it,” “build all,” or equivalent select **AFK/autonomous mode**. This preauthorizes recommended local choices and reversible, bounded fixer replacement/correction within the ratified plan. Interrupt autonomous work only for a hard stop. Otherwise use interactive mode and request only checkpoints required below.

## Select one execution profile

Determine the active harness/provider once.

### Claude profile

- Planner: Fable, effort `high`.
- Implementer: Opus, effort `medium`.
- Per-chunk verifier: Opus, effort `xhigh`.
- Whole-stack reviewer: Fable.

### Pi / OpenAI profile

- Planner: one fresh GPT-5.6 Sol agent, effort `high`.
- Implementer: GPT-5.6 Sol, effort `low`; request `low` explicitly because Pi maps Sol `minimal` to provider `low`.
- Per-chunk verifier: one fresh GPT-5.6 Sol agent, effort `high`; never use `xhigh` per chunk.
- Whole-stack reviewer: Sol `high`, or the single `xhigh` pass only when the stack crosses security, authorization, migration, concurrency, or data-integrity boundaries.
- Do not run an external Sol pass: Sol already implemented and reviewed the work.

For every profile: at most two children may run concurrently, and a child never delegates.

## Shared bounds

- One broad quality gate per diff revision. Adversarial verification and `/code-review` are alternatives, not cumulative rituals.
- One broad verifier creates the revision's immutable finding set. Later remediation, rechecks, and confirmations cannot start broad review, invent findings, or add unrelated scope.
- Run declared typecheck/tests in the orchestrator once after implementation and once after remediation when code changed. After a permitted surgical correction, rerun only affected gates once. Review agents do not rerun green gates unless a concrete accepted finding requires focused reproduction.
- Review from the brief and diff. Read source only to validate a concrete candidate finding; never browse the whole tree for confidence theater.
- Pi/Sol agents follow root `AGENTS.md` read-efficiency rules. Briefs, diffs, histories, and test output live in files; pass paths, not pasted walls.

## Per chunk

1. **Brief**: write `.tmp/` implementation brief with binding plan sections, deliverables, neighbor files, enumerated tests, exclusions, and exact diff base.
2. **Implement**: one selected-profile implementer works directly in the chunk worktree without committing. The orchestrator inspects the diff and runs the brief's gates.
3. **Broad verification**: one selected-profile verifier re-derives behavior from the brief and diff, checks named race/edge paths, and reports only concrete findings scoring ≥80. Give it the gate summary; it does not rerun broad gates. Record every finding and its disposition. Accepted findings become the immutable remediation set; disputed or deferred findings cannot re-enter later passes.
4. **One logical remediation phase**: implement every accepted finding, or record a concrete hard blocker for it. Consolidate the set into one fix brief. Prefer the original implementer; resume or replace any incomplete assignment as needed, or partition the set into non-overlapping assignments. All attempts remain one phase, and at most two children may run concurrently.
   - A failed or harness-incomplete child, context/capacity exhaustion, compile failure, unfinished test, or “needs investigation” result is incomplete execution, not a consumed remediation phase and not a review loop. Preserve completed work, then resume or replace the unfinished assignment.
   - Child underperformance is not itself a hard stop. Do not mark remediation complete while an accepted finding lacks either an implementation or a qualifying hard blocker.
5. **Targeted recheck and correction**: rerun affected gates once, then perform one recheck limited to accepted findings and lines changed for them. The recheck cannot create a new finding set. If it finds a failure traceable to the immutable set, permit one surgical correction, rerun only affected gates once, and perform one final targeted confirmation. No broad rediscovery. If material accepted findings remain, the correction cap is exhausted: stop.
6. **Review evidence**: save the exact final patch with `{ git diff "$base_ref"...HEAD; git diff HEAD; } > .tmp/build-feature-reviewed.diff`. Write exact `base_ref`, finding dispositions, remediation assignments, gate outcomes, recheck/correction outcome, and caveats to `.tmp/build-feature-review-evidence.md`. `/create-pr` compares the same patch shape after commit, avoiding a duplicate audit.
7. **Stacked PR**: commit via `/commit`, then `/gh-stack` + `/create-pr`. Base each chunk branch on the previous chunk; base the first on `origin/main`. `/create-pr` owns `gh stack submit`; verify afterward that `gh stack view --json` reports a Stack.
8. **Additional code review**: do not automatically run `/code-review` after Step 3 reviewed the current final diff. Run it only when explicitly requested, the diff materially changed outside accepted-finding remediation after the targeted confirmation, or Step 3 was skipped. Record the reason.

## Hard stops and decomposition

Hard stops are limited to:

- an unratified migration, public-contract, or destructive decision;
- concrete evidence that scope crosses an ownership/lifecycle boundary and requires plan/stack decomposition;
- mandatory external proof with no deterministic substitute; or
- exhausted surgical-correction cap with material accepted findings remaining.

Missing optional live credentials or optional smoke coverage is a recorded caveat, not a stop. Use available deterministic substitutes and continue.

Do not split because implementation is incomplete, gates are red, planned tests remain, an agent underperformed, context ran out, or the diff remains within the ratified budget. Decompose only with concrete scope/ownership evidence: identify the independently owned lifecycle or state machine, show why the current chunk must coordinate it, preserve the patch, and propose the revised stack for ratification. In autonomous mode, this qualifying plan change still requires interruption because it is a hard stop.

## After the last chunk

9. **Whole-stack review**: review `git diff origin/main...<tip>` once for cross-PR seams, plan conformance, and invariants not visible within one chunk. Before launch, report proposed model, effort, and whole-stack diff line/file counts; obtain confirmation in interactive mode unless the request already specified them. In autonomous mode, record the selection and proceed without interruption. Claude uses Fable. Pi/OpenAI uses Sol `high`, or its single allowed `xhigh` pass for the high-risk boundaries above.
10. Record a disposition for every whole-stack finding and fold accepted findings into one immutable batch. Apply Steps 4–5 to that batch: complete or hard-block every accepted finding, run affected gates, and perform the bounded targeted recheck/correction. Do not push while an affected gate is red or a material accepted finding remains; an exhausted correction cap is a hard stop. Otherwise push and report per-PR links. Do not use a second external model unless explicitly requested.

## Operational gotchas

- Workflow `args` are real JSON values, not a stringified blob; briefs belong in files.
- Stacked PRs run the main CI trio only when targeting `main`; run required local gates before submission.
- Merge and sync through `gh stack`; never hand-roll rebases around squash merges.
- Pre-commit runs full monorepo lint and typecheck. Use a generous timeout; run `bun install` first in fresh worktrees.
