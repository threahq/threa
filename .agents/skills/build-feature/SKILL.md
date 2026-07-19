---
name: build-feature
description: Build a planned feature as a stacked PR chain with per-chunk implement → adversarial-verify → fix loops and multi-model reviews. Use when asked to /build-feature, or to build out a ratified plan with the Opus implement + xhigh adversarial verify + code-review pipeline.
---

# Build a feature as a reviewed stacked-PR chain

The working rhythm: every chunk is implemented by one agent, adversarially verified by a stronger-effort agent, fixed, PR'd, and machine-reviewed — then the whole stack gets a top-model pass and (optionally) a second-model external pass.

## Preconditions

- A ratified plan doc in `docs/plans/<feature>.md` containing a PR-stack breakdown. No plan → write one and get it ratified first; do not start building from a chat message.
- Deferred items in the plan are binding: do not build them.

## Per chunk (repeat until the stack is done)

1. **Brief**: write the chunk's implementation brief to a scratchpad file — plan sections that bind, deliverables, neighbor files to imitate, enumerated tests, what NOT to build. Agents get the file path, not a pasted wall.
2. **Implement**: one agent, Opus, effort `medium`, working directly in the branch's working tree (no commits).
3. **Adversarially verify**: one agent, Opus, effort `xhigh`, structured findings output. It must not trust the implementer's report: it re-derives from the diff, walks the race/edge paths the plan names, and runs typecheck + the relevant test suites itself.
4. **Fix**: the medium agent fixes blockers/majors; the xhigh agent re-checks the fix list. Loop until clean.
5. **Stacked PR**: commit (use `/commit`), then `/gh-stack` + `/create-pr` — each chunk's branch based on the previous chunk's (first chunk on `origin/main`). If `gh stack` is unavailable, plain branches + `gh pr create --base <parent-branch>`, rebasing children as parents move.
6. **Code review**: an Opus agent runs `/code-review` on the PR; confirmed findings get fixed and pushed before the next chunk starts.

## After the last chunk

7. **Whole-stack review**: the top model (Fable) adversarially reviews the entire stack diff (`git diff origin/main...<tip>`) — cross-PR seams, plan conformance, invariant sweep.
8. **External second model** (optional, ask the user about quota): GPT-5.6 Sol via Pi — `pi --provider openai-codex --model gpt-5.6-sol -p --no-tools --no-session --thinking high "$(cat review-brief-with-diff)"`. Output buffers until the run completes; budget 10-25 min.
9. Fold surviving findings, push, report per-PR links.

## Gotchas (earned)

- Workflow `args` must be real JSON values, not a stringified blob; briefs go in files.
- Stacked PRs only run the main CI trio when targeting `main` — run `bun run test:unit` (and friends) locally before merging anything.
- Merge order: squash-merging a base PR with `--delete-branch` auto-closes its children — rebase children onto `main` (dropping squashed commits with `--onto`) before merging down the stack.
- Pre-commit runs full monorepo lint+typecheck: give commit commands a generous timeout, and fresh worktrees need `bun install` first.
