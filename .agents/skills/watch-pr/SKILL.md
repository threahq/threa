---
name: watch-pr
description: Watch a GitHub pull request for comments, reviews, thread resolution, CI check transitions, status updates, description edits, new commits, and merge-state changes. Use when asked to babysit, monitor, wait on, merge when ready, or fix CI on a PR.
---

# Watch a GitHub PR

Use the bundled Bun watcher instead of hand-written polling loops. Resolve paths relative to this skill directory.

```bash
WATCH_PR="<skill-directory>/watch-pr.ts"
STATE="${TMPDIR:-/tmp}/watch-pr-OWNER-REPO-NUMBER.json"
```

## Commands

Current state:

```bash
bun "$WATCH_PR" 123 --repo owner/repo --once --state "$STATE"
```

Wait for the next change:

```bash
bun "$WATCH_PR" 123 --repo owner/repo --interval 20 --timeout 1800 --state "$STATE"
```

The PR target may be a number, GitHub PR URL, or omitted to infer the open PR for the current branch. Repository is inferred from `origin` unless `--repo` is passed. Branch inference matches both branch name and its configured push repository, so fork branches require the base repository via `--repo` when `origin` points to the fork. Authentication uses `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`.

Output is NDJSON. A watch emits a compact `baseline`, reports retryable network/API failures as `poll_error`, then exits on the first `changes` event. Change events include full changed resources and a compact PR summary; use `--once` when the full snapshot is needed. Exit 3 means timeout without changes. The state file makes the next invocation compare against the last observation, closing the gap while the agent handles an event.

## Event coverage

Snapshots include:

- PR title, description, open/closed/merged state and timestamps, draft state, head SHA/ref, base ref, mergeability, and mergeable state
- Issue comments and inline review comments: author, full body, timestamps, URL, file/line, and reply parent
- Submitted reviews: author, state, body, timestamp, commit, and URL
- Review threads: resolved/outdated state and up to 100 comments per thread; the separately paginated inline-comment list remains complete
- Check runs: app, name, queued/in-progress/completed status, conclusion, timestamps, and details URL
- Current legacy commit status per context: state, description, timestamps, and target URL

Changes contain both `before` and `after` values for updates. Do not infer CI failures from a check name or conclusion alone; fetch the check's linked job logs before diagnosing.

## Babysitting loop

1. Take a snapshot with `--once`; inspect current blockers.
2. Act on anything actionable immediately.
3. Run the watcher in the foreground. A blocking tool call is intentional: its completed output is injected into both Pi and Claude Code context without harness-specific hooks.
4. On a change, reassess the whole returned snapshot, not only the diff. Handle review feedback with the `respond-to-pr-review` skill.
5. Re-run with the same state path until the requested terminal condition is true.
6. Before merging, fetch one final `--once` snapshot and verify:
   - PR remains open, non-draft, and points at the expected head SHA.
   - Every required check/status is successful; none queued or in progress.
   - No unresolved review thread or unhandled new/edited comment remains.
   - Latest applicable human reviews satisfy repository policy; no current change-request review remains.
   - Mergeability is acceptable and CodeRabbit is no longer processing.
7. Merge only when the user's requested condition is satisfied. Never treat a timeout as success.

GitHub has no generic “handled comment” state. Determine handling from thread resolution/replies and project review policy. CodeRabbit's processing marker is bot-specific comment content, so inspect current comments rather than baking wording into the watcher.

## Injection limits

A skill cannot autonomously wake an idle agent. The portable mechanism is a foreground watcher process whose tool result becomes model context when a change occurs. Pi could add an extension that calls `pi.sendUserMessage(..., { deliverAs: "followUp" })`; Claude Code has no equivalent general external-event injection API. Keep the executable as the shared source of truth even if a Pi adapter is added later.
