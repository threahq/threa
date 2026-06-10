---
name: sync-plan
description: Embed or refresh the implementation plan inside the PR description as a collapsible details block. Use before/after creating a PR so CodeRabbit and reviewers have accurate plan context without committing plan files to the repo.
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(gh pr view:*), Bash(gh pr edit:*), Bash(gh api:*), Read, Write, Edit, Glob, Grep, Agent, Skill(find-plan)
---

# Sync Plan

Keeps the implementation plan **in the PR description**, inside a collapsible
`<details>` block, so it travels with the PR for review and CodeRabbit plan-adherence
checks — without committing a plan file to the repo.

Plans are **not** committed to the repository. Committed plan files (`.claude/plans/*.md`)
added bloat, made diffs harder to size up, and confused future agents that globbed them.
The PR description is the single home for the plan: the title and prose give the high-level
summary; the `<details>` block holds the full plan.

## When to Use

- Before `/create-pr` — so the PR is created with the plan already embedded
- After significant implementation changes that diverge from the original plan
- When a reviewer (or CodeRabbit) needs the full plan context on an existing PR

## The Plan Block Format

The full plan lives in a `<details>` block with a **stable marker** so tooling can find
and replace it. Always use this exact summary line so the block is machine-locatable:

```markdown
<details>
<summary>📋 Full implementation plan</summary>

[full plan content — see structure in Step 4]

</details>
```

The block goes near the **end** of the PR body, after the human-facing sections
(Problem / Solution / design decisions / file tables / test plan), so the description
reads as a summary first and the long plan stays collapsed.

## Step 1: Gather Branch + PR Context

Run in parallel:

```bash
# Branch name
git branch --show-current

# All commits on this branch not on main
git log main..HEAD --oneline

# Files changed vs main
git diff main...HEAD --stat

# Existing PR + current body (the baseline to update). Empty output = no PR yet.
gh pr view --json number,title,body 2>/dev/null
```

If a PR exists, its body is the baseline. Look for an existing
`<summary>📋 Full implementation plan</summary>` block — that is the plan to update.

## Step 2: Recover Plan Intent + Session Context

**2a. Run `/find-plan`** to surface the original intent, course corrections, and design
decisions from conversation history. This is the most valuable input for the WHY — the diff
shows what changed, find-plan explains why.

**2b. If find-plan returns nothing and no PR body plan exists:**
1. Ask the user what the feature is about, or
2. Derive intent from the commits and diff (Step 3).

## Step 3: Understand What Was Actually Built

```bash
git diff main...HEAD
```

For large diffs, use `--stat` first, then read the most important files directly. Focus on
new files (what was created), modified files (what changed and why), deleted files, and
migrations (schema changes).

## Step 4: Compose the Plan Content

Write the full plan with this structure (this is the body that goes **inside** the
`<details>` block):

```markdown
## Goal

[One-paragraph summary of what this change accomplishes and why]

## What Was Built

### [Component/Area 1]

[What was implemented, key design decisions, and why]

**Files:**
- `path/to/file.ts` — [what this file does]

### [Component/Area 2]

[Same pattern]

## Design Decisions

### [Decision title]

**Chose:** [what was chosen]
**Why:** [reasoning]
**Alternatives considered:** [if any]

## Design Evolution

[Course corrections from /find-plan. Only significant direction changes.]

- **[What changed]:** [Original approach] → [New approach]. [Why.]

## Schema Changes

[Migrations added, what they do]

## What's NOT Included

[Out-of-scope or deferred items. Prevents false positives on "missing" changes.]

## Status

- [x] [Completed item]
- [ ] [Pending item, if any]
```

### Writing Guidelines

- **Describe what IS, not what was planned.** Reflect the actual implementation.
- **Use session context for the WHY.** Design decisions and course corrections from
  conversations are the most valuable parts for reviewers.
- **Be specific about file paths.** CodeRabbit needs concrete references to match the diff.
- **Include "Design Evolution" when the approach changed**, and "What's NOT Included" to
  prevent CodeRabbit from flagging intentional omissions as missing changes.
- **Keep it concise.** A review aid, not a design doc. Target 100-300 lines.
- **Do NOT invent requirements.** If something is unclear, ask.
- **Do NOT include side quests** — only what's relevant to this PR.

## Step 5: Write the Plan Into the PR Description

The plan goes in the PR body, not a file. Two cases:

**No PR yet:** Hand the composed plan to `/create-pr`, which places it in the
`<details>` block in the body it creates. (If you're running `/create-pr` already, you have
the content — just embed it.)

**PR exists:** Update the body, replacing any existing plan block (matched by the
`<summary>📋 Full implementation plan</summary>` marker) and keeping the human-facing
summary sections intact.

```bash
# Capture the current body, splice the plan block, write to a temp file.
gh pr view --json body -q '.body' > /tmp/claude/pr-body.md
# Edit /tmp/claude/pr-body.md: replace the existing details block, or append a new one
# at the end of the body if none exists. Then:
gh pr edit --body-file /tmp/claude/pr-body.md
```

If `gh pr edit` fails with a GraphQL warning, it usually still succeeded — verify with
`gh pr view --json body`. As a fallback use the API:

```bash
gh api repos/{owner}/{repo}/pulls/<number> --method PATCH -f body="$(cat /tmp/claude/pr-body.md)"
```

## Step 6: Confirm

Tell the user what changed:

```text
Plan synced into PR #<number> description.
- Summary sections: [unchanged | updated]
- Plan block: [created | updated]
- Status: [x completed, y pending]
```

Do **not** commit anything — the plan lives only in the PR description.

## Important Notes

- **One plan per PR.** Sub-features go in sections of the one block, not separate blocks.
- **Preserve the human-facing summary.** Never overwrite Problem/Solution prose with the
  plan; the plan is the collapsed detail, not the headline.
- **Never commit plan files.** `.claude/plans/` is gitignored. If you find a stray plan
  file in the working tree, do not `git add` it.
