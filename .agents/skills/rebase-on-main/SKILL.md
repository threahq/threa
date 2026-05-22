---
name: rebase-on-main
description: Rebase the current feature branch onto the latest origin/main for our squash-merge workflow, then force-push. Use when asked to "rebase on main", "rebase on origin main", "update my branch with main", "rebase because we squash merge", or to clean up a branch stacked on a squash-merged PR.
---

# Rebase onto origin/main (squash-merge workflow)

We **squash merge** every PR. That means a merged branch's individual commits never
land on `main` — they collapse into one brand-new commit with a different hash. So you
cannot `git merge main` or rely on git auto-dropping commits by patch-id; you must
**rebase onto a freshly-fetched `origin/main`**, and drop any commits that were already
squash-merged.

## Critical rules

- **ALWAYS rebase onto `origin/main`, never the local `main` branch.** In the sandbox the
  local `main` is often wildly out of date. Every run must start with `git fetch origin main`
  and then target the `origin/main` remote-tracking ref. Never `git checkout main`, never
  `git rebase main`.
- **Auto force-push when the rebase finishes cleanly** using `--force-with-lease` (never a
  bare `--force`). `--force-with-lease` aborts if the remote moved underneath you.
- **Stop and hand back to the user only if there are real merge conflicts** that need human
  judgement. Never `git rebase --skip`/`--abort` your way past a real conflict, and never
  force-push a half-finished rebase.

## Steps

### 1. Fetch the real main and capture state

```bash
git fetch origin main
BRANCH=$(git branch --show-current)
echo "branch=$BRANCH"
# Sanity: refuse to run on main/detached HEAD
[ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] || { echo "Not on a feature branch — abort" >&2; exit 1; }
# Commits that are on your branch but not on the up-to-date origin/main:
git log --oneline origin/main..HEAD
```

If `BRANCH` is empty (detached HEAD) or `main`, stop and tell the user — there is nothing
safe to rebase.

### 2. Decide simple vs. stacked

Look at the `origin/main..HEAD` list from step 1:

- **Simple case** — every commit listed is genuinely your own unmerged work. Go to step 3a.
- **Stacked-on-a-squashed-parent case** — some of those commits belong to an earlier PR that
  was already squash-merged (their work is already in `origin/main`, but under a different
  commit hash, so they still show up here). Those commits will phantom-conflict on a plain
  rebase. Go to step 3b.

How to tell them apart: skim the listed commits against recent `origin/main` history
(`git log --oneline origin/main -20`). If a commit's change is already represented by a squash
commit on main (matching PR title / same content), it's an already-merged commit and must be
dropped, not replayed.

### 3a. Simple rebase

```bash
git rebase origin/main
```

- Clean finish → go to step 4.
- Conflicts → go to step 5.

### 3b. Stacked rebase (`--onto` to drop the squashed commits)

Find `OLD_BASE` = the **newest already-squash-merged commit** in the `origin/main..HEAD`
list (the last commit whose work is already on main). Everything *after* `OLD_BASE` is your
new work to keep. Then replay only the new work onto the fresh main:

```bash
# OLD_BASE = sha of the last already-merged commit (the parent PR's tip)
git rebase --onto origin/main "$OLD_BASE"
```

This drops `OLD_BASE` and everything before it, replaying only `OLD_BASE..HEAD` onto
`origin/main` — so the squash-merged commits disappear and no longer conflict.

If the cut point is ambiguous (you can't confidently tell which commits are already merged),
ask the user to confirm `OLD_BASE` before running — getting it wrong drops real work.

- Clean finish → go to step 4.
- Conflicts → go to step 5.

### 4. Force-push (auto, on a clean rebase)

```bash
git push --force-with-lease -u origin "$BRANCH"
```

Retry on network errors only, with exponential backoff (2s, 4s, 8s, 16s). If
`--force-with-lease` is rejected because the remote moved, do **not** escalate to `--force` —
re-fetch, tell the user the remote changed, and let them decide.

Then report: which commits were dropped (if any), how many were replayed, and the new tip.

### 5. Conflicts — stop for the human

```bash
git status   # show the conflicted files
```

Resolve only conflicts that are mechanical and unambiguous. For anything requiring real
judgement, stop and hand back to the user with the list of conflicted files and the current
`git rebase` state. Once conflicts are resolved (`git add` + `git rebase --continue` until the
rebase completes), return to step 4. Never force-push mid-rebase.

## Quick reference

```bash
git fetch origin main                       # ALWAYS — never trust local main
git rebase origin/main                       # simple case
git rebase --onto origin/main <old-base>     # stacked-on-squashed-parent case
git push --force-with-lease -u origin <branch>   # auto-push on clean finish
```
