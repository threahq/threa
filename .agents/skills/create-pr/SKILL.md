---
name: create-pr
description: Create a pull request with a dense, verified description. Use when asked to create a PR, open a PR, or submit changes for review.
---

# Create Pull Request

Self-review, write a dense verified description, open the PR, subscribe. Invoking this skill is the request for all of it.

## Flow

1. **Context** (parallel): `git branch --show-current` · `git status -sb` · `git log main..HEAD --oneline` · `git diff main...HEAD --stat` · `git diff main...HEAD` (read it). Ticket: `git branch --show-current | grep -oiE 'thr-[0-9]+' | tr '[:lower:]' '[:upper:]'` — if found, in title + linked in body; else cite audit/design ids (`E2EE-22`, `INV-62`) in body.
2. **Draft Problem + Solution** before verifying — your claims become assertions step 3 holds against the code. A claim like "the prune is atomic" is description *and* correctness check; verifying catches prose drift and real bugs in one pass.
3. **Self-review + verify every claim.** Walk the diff as a reviewer: race-safe writes (INV-20), workspace scoping (INV-8), outbox-in-tx (INV-4/7), canonical access predicates (INV-62), no silent fallbacks (INV-11), Zod inputs (INV-55), dead code (INV-38). Substantial change → `/code-review` on the diff. Then per draft sentence: named files/symbols exist and do what you said; behavioral claims ("atomic", "reads X before Y", "no schema change") literally true; INV refs apply; numbers match constants; "not included" claims real. Findings → fix in branch, note honestly: `(caught in self-review; commit N)` inline, or one-line tally in test plan ("Pre-PR review: 2 fixed, 3 dismissed pre-existing").
4. **Files table + test plan** — after review, real run counts. Never check an unrun box; unchecked + honest reason beats a checkmark nobody can trust.
5. **Create.** First, **is this branch part of a stack?** Run `gh stack view --json` — if it succeeds and lists the current branch, this is a stacked branch and the flow differs (see "Stacked branches" below). Otherwise: body to `.tmp/pr-body.md`, then `gh pr create --base main --title "…" --body-file .tmp/pr-body.md`. Web/remote sessions (no `gh`): `mcp__github__create_pull_request`; fallback `gh api repos/{owner}/{repo}/pulls --method POST`. Always return the PR URL.
6. **Subscribe**: `mcp__github__subscribe_pr_activity` if available; say so. Skip if user declined watching.

## Stacked branches

If step 5 found the branch in a `gh stack`, a plain `gh pr create` is the wrong tool — it opens a PR that is **not linked into the GitHub Stack**, so reviewers never see the stack navigation and `gh stack` merge/sync can't drive it. Do the per-branch work of steps 1–4 the same way (verified body to `.tmp/pr-body.md`), then:

1. `gh pr create --base <parent-branch> --title "…" --body-file .tmp/pr-body.md` — base is the branch **below** this one in the stack (`gh stack view` shows it), never `main` for anything but the bottom branch.
2. **`gh stack submit --auto --open`** — this is the step that actually creates the GitHub Stack. It adopts the PRs you just made ("… is up to date"), links them, and adds the stack nav block. **Creating the PRs is not enough; without `submit` they are just chained-base PRs, not a Stack.** Run it once from any branch in the stack — it links the whole stack.

Verify with `gh stack view --json` (a `Stack #NNNN` now exists). See the `gh-stack` skill for the full contract.

## Description template

Reader model: Problem/Solution get read, file table gets skimmed, below that only tooling looks. Keep the top dense, the bottom minimal and collapsed.

```markdown
**Linear:** [THR-XX](https://linear.app/threa/issue/THR-XX) _(if any)_

## Problem

[2–4 sentences. The defect/limitation with real files/symbols/ids. Why it matters.]

## Solution

[Shape in one sentence, then mechanism as tight bullets — real functions, files,
numbers. Fold decisions in as "X over Y — reason" bullets only where a real
alternative existed. Deliberate deviations / out-of-scope: one line each, so a
reviewer doesn't "fix" them.]

## Files

| File | Change |
| ---- | ------ |
| `path.ts` | What changed (**new** / **deleted** where applicable) |

## Test plan

- [x] suite — N pass
- [ ] not done — honest reason

<details>
<summary>📋 Full implementation plan</summary>

[Via /sync-plan or /find-plan. Keep this exact summary line — CodeRabbit,
/code-review, /update-pr find the block by it. Omit when no plan exists.]

</details>

---

🤖 _PR by [Claude Code](https://claude.com/claude-code)_
```

Match weight to change: docs/one-file PR = Problem / Solution / Test plan only. Don't pad a one-liner; don't crush a rewrite into three sentences.

## Style

- Fact-per-word. If a sentence survives deleting half its words, delete them.
- Name real things — `resolveActorRecipients`, `?panel=`, `20260613064500_sync_log_retention.sql`. "The relevant helper" means unverified.
- Concrete numbers ("30-day horizon + ~2,000-row floor", "200ms skeleton delay"), never "configurable"/"small viewports".
- Decisions carry the rejected alternative and its failure mode; cite invariants and rulings verbatim ("Kris's call", "the audit's words (E2EE-22)").
- No slop: "comprehensive", "robust", "seamless", "powerful", "simply". Understated; honest about what's not covered — that candor is what makes the rest trustworthy.

## Title

`<type>(THR-XX): specific summary` — feat/fix/refactor/docs/test/chore; omit parenthetical when no ticket. Title alone says what changed: `feat: sync_log retention with below-floor bootstrap fallback`, not `feat: update sync`.
