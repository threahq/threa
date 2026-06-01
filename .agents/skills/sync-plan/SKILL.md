---
name: sync-plan
description: Ensure a committed plan file exists and reflects the current branch state. Use before creating a PR to give CodeRabbit accurate plan context for adherence checking.
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git branch:*), Bash(git add:*), Bash(git commit:*), Bash(git status:*), Bash(gh pr view:*), Read, Write, Edit, Glob, Grep, Agent, Skill(find-plan)
---

# Sync Plan

Produces or updates a committed plan file at `.claude/plans/<branch>.md` that accurately reflects the current branch state. This gives CodeRabbit (and future reviewers) a clear spec to check plan adherence against.

## When to Use

- Before `/create-pr` — ensures the PR has an up-to-date plan committed
- After significant implementation changes that diverge from the original plan
- When starting a new feature branch that doesn't have a plan yet

## Step 1: Gather Branch Context

Run in parallel:

```bash
# Branch name
git branch --show-current

# All commits on this branch not on main
git log main..HEAD --oneline

# Files changed vs main
git diff main...HEAD --stat
```

Also use the Glob tool to check for existing plan files: `.claude/plans/*.md`

Derive the branch slug for the plan filename: strip prefixes like `feat/`, `fix/`, `chore/`, and use the rest (e.g., `feat/multi-modal-images` → `multi-modal-images`).

## Step 2: Find Existing Plan and Session Context

**2a. Check for an existing committed plan file** at `.claude/plans/<branch-slug>.md`.
If found, read it — this is the baseline to update.

**2b. Run `/find-plan` to gather session context.**

This surfaces the original intent, course corrections, and design decisions from conversation history. The find-plan skill will:
- Find plan mode sessions and plan-like discourse across all sessions for this project
- Classify sessions as MAIN, SUBSTEP, SIDE_QUEST, or INVESTIGATION
- Identify course corrections where the approach changed mid-implementation
- Return a structured view of all plans chronologically

Store the find-plan output — you'll use it in Step 4 to capture design decisions and course corrections that aren't visible in the diff alone.

**2c. If neither a plan file nor session plans were found:**
1. Check the PR description (if a PR exists): `gh pr view --json body -q '.body'`
2. Ask the user what the feature is about

## Step 3: Understand What Was Actually Built

Read the full diff to understand the implementation:

```bash
# Detailed diff for understanding changes
git diff main...HEAD
```

For large diffs, use `--stat` first, then read the most important files directly. Focus on:
- New files (what was created)
- Modified files (what was changed and why)
- Deleted files (what was removed)
- Migration files (schema changes)

## Step 4: Produce the Plan File

Write `.claude/plans/<branch-slug>.md` with this structure:

```markdown
# [Feature Name]

## Goal

[One-paragraph summary of what this feature/change accomplishes and why]

## What Was Built

### [Component/Area 1]

[What was implemented, key design decisions, and why]

**Files:**
- `path/to/file.ts` — [what this file does]
- `path/to/other.ts` — [what this file does]

### [Component/Area 2]

[Same pattern]

## Design Decisions

### [Decision 1 title]

**Chose:** [what was chosen]
**Why:** [reasoning]
**Alternatives considered:** [if any]

### [Decision 2 title]

...

## Design Evolution

[Course corrections discovered via session history from /find-plan. Include only significant direction changes, not minor tweaks.]

- **[What changed]:** [Original approach] → [New approach]. [Why the change was made.]

## Schema Changes

[List any migrations added, what they do]

## What's NOT Included

[Explicitly call out things that are out of scope or deferred. This helps CodeRabbit avoid false positives on "missing" changes.]

## Status

- [x] [Completed item]
- [x] [Completed item]
- [ ] [Pending item, if any]
```

### Writing Guidelines

- **Describe what IS, not what was planned.** This file reflects the actual implementation, not the original aspirations.
- **Use session context for the WHY.** The diff shows what changed; the find-plan output explains why. Design decisions and course corrections from conversations are the most valuable parts for reviewers.
- **Be specific about file paths.** CodeRabbit needs concrete references to match against the diff.
- **Call out design decisions explicitly.** These are the things a reviewer would question — answer them preemptively.
- **Include "Design Evolution" when the approach changed.** If find-plan reveals course corrections, document the original → final approach and why. This prevents reviewers from questioning intentional pivots.
- **Include "What's NOT Included".** This prevents CodeRabbit from flagging intentional omissions as missing changes.
- **Keep it concise.** This is a review aid, not a design doc. Target 100-300 lines.

## Step 5: Diff and Confirm

If updating an existing plan, show the user what changed:

```
Plan updated. Changes:
- Added: [new sections]
- Updated: [sections that changed]
- Removed: [sections no longer relevant]
```

If creating a new plan, show the user the outline:

```
Plan created at .claude/plans/<branch-slug>.md
Sections:
- Goal: [one-line summary]
- Components: [list]
- Design decisions: [count]
- Status: [x completed, y pending]
```

Ask the user to confirm before committing: "Does this look right? I'll commit it so CodeRabbit can reference it during review."

## Step 6: Commit the Plan

```bash
git add .claude/plans/<branch-slug>.md
git commit -m "docs: sync plan for <branch-slug>"
```

After committing, tell the user the full path to the plan file so they can review it easily.

## Important Notes

- **Do NOT invent requirements.** The plan should reflect what was actually built, derived from the diff and commits. If something is unclear, ask.
- **Do NOT include session history or side quests.** This file is for CodeRabbit, not for archaeology. Only include what's relevant to the current PR.
- **Preserve existing plans when updating.** Don't discard the user's original plan structure — update it to match reality.
- **One plan per branch.** If the branch has sub-features, they go in sections, not separate files.
