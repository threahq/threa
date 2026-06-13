---
name: create-pr
description: Create a well-structured pull request with proper description, design decisions, and file changes. Use when asked to create a PR, open a PR, or submit changes for review.
---

# Create Pull Request

Self-review the change, write a dense and verifiable description, open the PR, and subscribe to it. This skill bakes in the full "self-review, then create a PR, then subscribe" flow — you do not need to be asked for the review or the subscribe separately.

## The flow (do these in order)

1. **Gather context** — commits, diff, ticket id, plan.
2. **Draft the prose** — high-level but dense (see Prose style). Write the Problem / Solution / How it works / Key design decisions first, from your understanding of the change.
3. **Self-review and verify every claim against the code** — this is the load-bearing step. Walk the diff for correctness *and* check that each factual claim in your draft is actually true of the code. Fix what you find; record the findings in the description.
4. **Finalize the file tables and test plan** — with real, run counts.
5. **Create the PR.**
6. **Subscribe to PR activity.**

The point of ordering it this way: writing the prose first forces you to state precisely what you believe the change does, and the verify pass then holds those statements against the actual code. A claim like "the prune is atomic" or "catch-up reads entries first" is both a description and a correctness assertion — verifying it catches prose drift and real bugs in the same pass. Reviewers can then trust the description to match the diff, which is the whole point.

---

## 1. Gather context

Run in parallel:

```bash
git branch --show-current          # current branch
git status -sb                     # tracking + dirty state
git log main..HEAD --oneline       # commits on this branch
git diff main...HEAD --stat        # files touched
git diff main...HEAD               # the actual change (read it)
```

Extract a Linear ticket id from the branch name if present:

```bash
git branch --show-current | grep -oiE 'thr-[0-9]+' | tr '[:lower:]' '[:upper:]'
```

If found, it **must** appear in the PR title (`feat(THR-19): …`) and as a link in the body. Many changes here are tracked by an audit-finding or design-doc id instead (`E2EE-22`, `agent-runtimes §2.7`, `INV-62`) — cite those the same way when there's no Linear ticket.

The implementation plan lives in the PR description, **not** the repo (`.claude/plans/` is gitignored). Run `/sync-plan` or `/find-plan` to compose the plan before writing the body; it goes in a collapsible `<details>` block at the end.

## 2. Draft the prose

Write the **Problem**, **Solution**, **How it works**, and **Key design decisions** sections now, before verifying — you're stating what you believe the change does so the next step can hold it against the code. Follow the Prose style section below. Don't fill in the file tables or test counts yet; those come after the review.

## 3. Self-review and verify every claim against the code

Two passes over the same diff. Do them together.

**Correctness pass.** Read the diff as a reviewer would. Look for the things this codebase cares about: race-safe write paths (INV-20), workspace scoping (INV-8), outbox-in-transaction (INV-4/7), access via the canonical predicates (INV-62), no silent fallbacks (INV-11), Zod-validated inputs (INV-55), dead code left behind (INV-38). For a substantial change, spawning a few parallel review agents over the diff is the established move here (see the "Pre-PR review (N reviewer agents)" line in recent merged PRs). The `/code-review` command reviews the current diff and is a good fit.

**Claim-verification pass.** Go through your draft sentence by sentence and confirm each concrete claim against the actual code:

- Every `path/to/file.ts`, function name, and symbol you named exists and does what you said.
- Every behavioral claim ("atomic", "race-safe", "reads X before Y", "one transaction", "no schema change", "required at boot") is literally true of the diff — open the lines and check.
- Every invariant reference (INV-XX) actually applies to what you changed.
- Every number (timeouts, counts, sizes, limits) matches a constant or default in the code.
- Every "out of scope / NOT included" claim is real — you didn't actually touch that thing.

When the review turns up a finding, **fix it in the branch**, then reflect it in the description honestly rather than hiding it:

- A correctness fix found mid-review → note it inline where relevant (`(caught in self-review; see commit N)`) or in a short **Design evolution (self-review)** note that says what the first version got wrong and how it's fixed. Recent PRs do exactly this — e.g. "Initial version read the floor before the entries query … a concurrent prune could silently drop entries. Fixed by folding the floor advance into the prune DELETE."
- A review pass with findings → a one-line tally in the test plan: "Pre-PR review (3 reviewer agents): 2 findings fixed (…), 3 dismissed as pre-existing/misapplied."

A clean review is a real outcome too — but only claim it after you've actually done the passes.

## 4. Finalize file tables and test plan

Now fill in the **New / Modified / Deleted files** tables and the **Test plan** — after the review, so the counts and per-file notes are accurate.

Run the relevant suites and record real numbers. Use checked boxes for what passed with counts, and **unchecked boxes for what genuinely wasn't done**, with the honest reason:

```markdown
- [x] Backend `bun test src/features/sync` — 14 pass
- [x] `tsc --noEmit` across types / backend / frontend clean
- [ ] No live-DB harness, so the prune SQL is covered via stubbed repo like its siblings — not integration-tested
```

Never check a box you didn't run. An honest unchecked box with a reason is worth more than a green checkmark a reviewer can't trust.

## 5. Structure of the description

```markdown
**Linear:** [THR-XX](https://linear.app/threa/issue/THR-XX) _(if applicable)_

## Problem

[The concrete defect or limitation, with the specific files/symbols/ids involved.
Why it matters, and why it isn't trivial if that's relevant.]

## Solution

[One tight framing sentence — the shape of the approach, an analogy if it helps.
Then the substance.]

### How it works

[Numbered or bulleted mechanism. Each point names the real function/file and the
actual mechanism. Concrete numbers, not "configurable".]

### Key design decisions

**1. [Decision]** — [what was chosen, the alternatives rejected and their failure
modes, the invariant or user ruling behind it.]

## New files

| File | Purpose |
| ---- | ------- |
| `path/to/file.ts` | What it's for |

## Modified files

| File | Change |
| ---- | ------ |
| `path/to/file.ts` | What changed |

## Deleted files (if any)

| File | Reason |
| ---- | ------ |
| `path/to/file.ts` | Why removed |

## Out of scope (deliberate)

[What you consciously didn't do and why — names follow-up PRs / audit items.
Mark deliberate deviations so a reviewer doesn't "fix" them.]

## Test plan

- [x] [suite] — [N pass]
- [ ] [genuinely not done] — [honest reason]

<details>
<summary>📋 Full implementation plan</summary>

[From /sync-plan or /find-plan: Goal, What Was Built, Design Decisions, Design
Evolution, Schema Changes, What's NOT Included, Status. Keep the exact summary
line above so tooling (CodeRabbit, /code-review, /update-pr) can find the block.
Omit only if there's genuinely no plan beyond the prose.]

</details>

---

🤖 _PR by [Claude Code](https://claude.com/claude-code)_
```

Small PRs collapse this: a docs-only or one-file change uses **Problem / Solution / Files changed / Test plan** and skips the decision matrix and the plan block. Match the section weight to the change — don't pad a one-liner into the heavyweight shape, and don't crush a layout rewrite into three sentences.

## Prose style

The description should read high-level but stay dense and detail-oriented — a reviewer skims the prose to size up the change, then trusts it enough not to re-derive the diff. The benchmark is the recently merged feature PRs in this repo; open a couple before writing if you're unsure of the register.

**Lead with altitude, immediately land in specifics.** State the shape in one sentence ("a generic, URL-driven multi-panel layout in the spirit of VS Code editor groups"), then the very next clause is concrete — the real function, the real file, the real mechanism.

**Name real things.** `streamAccessPredicateSql`, `20260613064500_sync_log_retention.sql`, `resolveActorRecipients`, `?panel=`. Never "the relevant helper", "a config value", "some logic". If you can't name it, you haven't verified it.

**Concrete over vague, always.** "30-day horizon + per-workspace ~2,000-row floor", "below 420px the action bar collapses", "200ms skeleton delay" — not "a configurable retention window" or "small viewports".

**Explain the why and the rejected alternatives.** Decisions carry their tradeoff: "Time and count have opposite failure modes — pure time grows unbounded for a firehose workspace, pure count shrinks the healing window." A decision with no alternative stated reads like there was no choice to make.

**Quote the source of truth.** Audit findings, design-doc sections, and user rulings get quoted or cited verbatim ("the audit's words (E2EE-22): …", "Kris's call"). Cite invariants by id where they bind.

**Understated and factual — no slop.** No "comprehensive", "robust", "seamless"(unless literally describing a no-flash transition you verified), "powerful", "simply", "just", emoji-as-decoration, or marketing cadence. Active voice. Confident where the code earns it, honest where it doesn't. If a copy pass would help, the `/deslopify` skill targets exactly this register.

**Honesty is part of the style.** The strongest sections in this repo's PRs say what's *not* covered, what's deferred, what the first attempt got wrong. That candor is what makes the rest trustworthy. Don't sand it off.

## 6. Create the PR

Push, then create. In web/remote sessions `gh` is **not installed** — use the GitHub MCP tool.

```bash
git push -u origin "$(git branch --show-current)"
```

Write the body to a temp file first (avoids heredoc/quoting issues), then create via, in order of preference for this environment:

1. **MCP (web/remote sessions):** `mcp__github__create_pull_request` with `owner`, `repo`, `head` (current branch), `base: main`, `title`, and `body` (contents of the temp file).
2. **`gh` (local sessions where it exists):**
   ```bash
   gh pr create --base main --title "<type>(THR-XX): <short description>" --body-file /tmp/claude/pr-body.md
   ```
3. **REST fallback** if `gh` errors: `gh api repos/{owner}/{repo}/pulls --method POST -f title=… -f head=… -f base=main -f body="$(cat /tmp/claude/pr-body.md)"`.

### Title conventions

Conventional-commit type, optional scope, Linear id when there is one, and a **specific** summary — the title alone should say what changed:

- `feat(THR-XX): …`, `fix: …`, `refactor(backend): …`, `docs: …`, `test: …`, `chore: …`
- Good: `feat: sync_log retention with below-floor bootstrap fallback`. Weak: `feat: update sync`.
- Omit the parenthetical when there's no ticket. Cite audit/design ids (`E2EE-22`, `INV-62`) in the body instead.

### Return the URL

Always return the PR URL. Capture it from the MCP tool output / `gh` stdout / REST `html_url`. If it genuinely can't be determined, say so explicitly and give the title, branch, and the exact command to fetch it once resolved.

## 7. Subscribe to PR activity

This is part of the skill, not a separate ask. After the PR exists, call `mcp__github__subscribe_pr_activity` for it so the session wakes on CI results, review comments, and CodeRabbit findings, and follow through on those events (see the harness's PR-activity guidance). Tell the user you've subscribed and will watch it. If the user has said they don't want it watched, skip this step.

## Important

- Do not create a PR unless asked — but invoking this skill *is* the explicit request, so the create + subscribe steps proceed.
- Never ship an empty or minimal description, and never ship one whose claims you haven't checked against the code.
- Explain the why, not only the what. Surface divergences from the original plan.
- Run the tests you claim to have run.
