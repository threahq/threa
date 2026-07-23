---
name: build-feature
description: Build a planned feature as a stacked PR chain with per-chunk implementation, one non-duplicative review gate, bounded fixes, and runtime-specific Claude or Pi/OpenAI profiles.
---

# Build a feature as a reviewed stacked-PR chain

Build each plan chunk, verify it once with the strongest useful runtime profile, fix findings in one batch, and create the stacked PR before moving on. Preserve review quality without paying multiple agents to repeat the same lens on the same diff.

## Planning and preconditions

- The invoking agent remains the orchestrator at its current, lower reasoning level. It owns sequencing, user checkpoints, agent briefs, gates, and stack state; it does not become the planner.
- A ratified implementation plan containing a PR-stack breakdown is required. The plan embedded in the PR body by `/sync-plan` is authoritative. Files under `docs/plans/` are optional desired-design context, never implementation truth.
- No implementation plan → delegate investigation and drafting to one fresh high-reasoning planner, have the user ratify the result, then publish it with `/sync-plan` before implementation. Do not start building from a chat message.
- The planner writes the candidate plan but never orchestrates implementation or delegates children.
- Deferred items in the plan are binding: do not build them.

## Select one execution profile

Determine the active harness/provider once and record the profile in the first status update.

### Claude profile

- Planner: Fable, effort `high`.
- Implementer: Opus, effort `medium`.
- Per-chunk verifier: Opus, effort `xhigh`.
- Whole-stack reviewer: Fable.
- Preserve the established Claude behavior below, subject to the shared round and read bounds.

### Pi / OpenAI profile

- Planner: one fresh GPT-5.6 Sol agent, effort `high`.
- Implementer: GPT-5.6 Sol, effort `low`. Pi maps Sol `minimal` to provider `low`, so request `low` explicitly.
- Per-chunk verifier: one fresh GPT-5.6 Sol agent, effort `high`.
- Never use `xhigh` per chunk. Reserve it for one final whole-stack review only when the stack crosses security, authorization, migration, concurrency, or data-integrity boundaries; otherwise use `high`.
- Maximum two children running concurrently. A child never delegates.
- Do not run an external Sol pass: Sol already implemented and reviewed the work.

## Shared efficiency contract

- One quality gate per diff revision. Adversarial verification and `/code-review` are alternatives, not cumulative rituals.
- Maximum one batched fix pass and one targeted recheck per chunk. If material findings survive, stop for a human checkpoint; do not start another clean-room review.
- Run declared typecheck/tests once in the orchestrator after implementation and once after the fix batch when code changed. Review agents do not rerun green gates unless a concrete finding requires a focused reproduction.
- Review from the brief and diff. Read source only to validate a concrete candidate finding; never browse the whole tree for confidence theater.
- Pi/Sol agents follow the root `AGENTS.md` read-efficiency rules.
- Briefs, diffs, histories, and test output live in files. Pass paths, not pasted walls.

## Per chunk

1. **Brief**: write the chunk implementation brief to `.tmp/` — binding plan sections, deliverables, neighbor files, enumerated tests, exclusions, and the exact diff base.
2. **Implement**: one agent using the selected profile, directly in the chunk worktree, no commit. The orchestrator inspects the diff and runs the brief's gates.
3. **Adversarial verification**: one verifier using the selected profile. It re-derives behavior from the brief and diff, checks named race/edge paths, and reports only concrete findings scoring ≥80. It receives the green/failed gate summary; it does not rerun broad gates.
4. **Fix and recheck**: consolidate all accepted findings into one fix brief. The implementer or one fresh implementation-profile agent applies them as one batch. Rerun affected gates once, then use one targeted verifier recheck limited to the accepted findings and changed lines. No new broad review round. Save the exact reviewed final patch with `{ git diff "$base_ref"...HEAD; git diff HEAD; } > .tmp/build-feature-reviewed.diff` and write the exact `base_ref` plus reviewer/recheck outcome to `.tmp/build-feature-review-evidence.md`; `/create-pr` compares the same patch shape after commit to avoid repeating the audit.
5. **Stacked PR**: commit via `/commit`, then `/gh-stack` + `/create-pr`; each chunk branch is based on the previous chunk, first chunk on `origin/main`. `/create-pr` owns `gh stack submit`; this skill only verifies `gh stack view --json` reports a Stack afterward.
6. **Additional code review**: do not automatically run `/code-review` when Step 3 reviewed the current final diff. Run it only when the user explicitly requests it, the diff materially changed after the targeted recheck, or Step 3 was skipped. Record the reason.

## After the last chunk

7. **Whole-stack review**: one review of `git diff origin/main...<tip>` focused on cross-PR seams, plan conformance, and invariants not fully visible within a chunk. Claude uses Fable. Pi/OpenAI uses Sol `high`, or the single allowed `xhigh` pass for the high-risk boundaries listed above.
8. Fold surviving findings in one batch, run affected gates once, push, and report per-PR links. No second external model unless the user explicitly requests it. Before launch, report the proposed model, effort, and whole-stack diff line/file counts; obtain confirmation if the request did not already specify them.

## Gotchas

- **Decomposition checkpoint:** when a chunk exceeds its budget or starts coordinating independent lifecycle/state machines, stop before adding more machinery. Give the user a short split proposal along the ownership/lifecycle boundary, preserve the patch, ratify the revised stack, and continue in smaller PRs.
- Workflow `args` must be real JSON values, not a stringified blob; briefs go in files.
- Stacked PRs only run the main CI trio when targeting `main`; run required local gates before submission.
- Merge/sync stacks through `gh stack`; never hand-roll rebases around squash merges.
- Pre-commit runs full monorepo lint+typecheck: use a generous timeout, and fresh worktrees need `bun install` first.
