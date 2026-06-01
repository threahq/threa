---
name: respond-to-pr-review
description: Systematically triage and respond to PR review comments. Use when asked to check PR comments, address review feedback, respond to reviewers, or fix issues raised in code reviews.
---

# Respond to PR Review

Systematically triage, address, and respond to every review comment on a pull request. No comment should be silently skipped.

## Core Principle

**Every review comment gets an explicit disposition.** A comment is either:

1. **Accepted** — the feedback is valid, fix the code and respond
2. **Acknowledged** — the feedback is valid but out of scope for this PR; respond explaining why and what follow-up is planned
3. **Disputed** — the feedback is incorrect or conflicts with project rules; respond with a concrete explanation referencing the relevant invariant or rationale

Never silently skip a comment. Never dismiss a comment just because it is non-blocking, a suggestion, or an improvement rather than a bug. CodeRabbit is configured with project-specific rules — its feedback reflects project standards and should be treated with the same rigor as human review comments.

## Instructions

### 1. Determine PR number

If not provided, detect from current branch:

```bash
gh pr view --json number -q .number
```

### 2. Fetch all review comments and threads

Fetch both issue-level comments and inline review threads:

```bash
# Inline review comments
gh api repos/{owner}/{repo}/pulls/{pr}/comments

# Issue-level comments (summaries, top-level feedback)
gh api repos/{owner}/{repo}/issues/{pr}/comments

# Review thread resolution status
gh api graphql -f query='
query {
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {pr}) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 10) {
            nodes {
              author { login }
              body
              path
              line
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  }
}'
```

### 3. Check for updated comments

Compare `createdAt` vs `updatedAt` on each comment. If a comment was updated after a previous response, it means the reviewer edited their feedback — treat it as new input that needs re-evaluation.

Also check for reply chains: if a reviewer responded to your previous reply, that thread needs attention regardless of resolution status.

### 4. Build a triage table

For EVERY unresolved comment (and resolved comments with new replies), create a triage entry:

| # | Source | File:Line | Issue Summary | Disposition | Action |
|---|--------|-----------|---------------|-------------|--------|

Fill in Source (coderabbitai[bot], human username), the file and line, a one-sentence summary of the issue, and leave Disposition/Action blank.

Present this table to the user and ask for confirmation before proceeding. The user may override dispositions or skip specific comments.

### 5. Read code and triage each comment

For each comment, read the relevant code and determine the disposition:

- **Accept**: The issue is real and should be fixed in this PR
- **Acknowledge**: The issue is real but belongs in a follow-up (explain why — scope, risk, separate concern)
- **Dispute**: The issue is incorrect — cite the specific invariant, spec, or technical reason

Do not use weasel language like "just a suggestion", "non-blocking", or "nice to have" to skip valid feedback. If the feedback identifies a real issue (bug, regression, accessibility problem, spec violation), it should be accepted regardless of how the reviewer labeled its severity.

### 6. Fix accepted issues

For each accepted comment:

1. Fix the code
2. Reply to the thread explaining the fix

### 7. Respond to acknowledged/disputed comments

For each non-accepted comment, reply to the thread with:

- **Acknowledged**: What the issue is, why it's deferred, and what follow-up is planned (e.g., "Will address in a separate PR" or "Tracking as part of [issue]")
- **Disputed**: The concrete technical reason the feedback doesn't apply, referencing project invariants or specs where relevant

### 8. Post replies

All responses MUST end with the agent signature:

```
🤖 _Response by [Claude Code](https://claude.com/claude-code)_
```

Write the response to a temp file first (to avoid heredoc issues), then post:

```bash
mkdir -p /tmp/claude

printf '%s\n' \
  '[response body]' \
  '' \
  '🤖 _Response by [Claude Code](https://claude.com/claude-code)_' \
  > /tmp/claude/pr-comment.md

gh api graphql -f query='
mutation($body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: "{thread_id}"
    body: $body
  }) {
    comment { id }
  }
}' -f body="$(cat /tmp/claude/pr-comment.md)"

rm /tmp/claude/pr-comment.md
```

### 9. Resolve threads

Only resolve threads where the disposition is **Accept** (code was fixed) or **Dispute** (with explanation posted). Do NOT resolve **Acknowledged** threads — those stay open as a reminder for follow-up.

```bash
gh api graphql -f query='
mutation {
  resolveReviewThread(input: { threadId: "{thread_id}" }) {
    thread { isResolved }
  }
}'
```

### 10. Commit and push

Commit all fixes with a message referencing the review feedback, then push.

### 11. Report final status

After all comments are handled, present the completed triage table with final dispositions:

| # | Source | File:Line | Issue Summary | Disposition | Response |
|---|--------|-----------|---------------|-------------|----------|

This gives the user a clear audit trail of what was done with every comment.

## Examples

**User says:** "Check the PR comments"
**Action:** Fetch all comments, build triage table, present for review, then address each systematically

**User says:** "Address the review feedback on PR 42"
**Action:** Fetch comments for PR #42, triage all, fix accepted issues, respond to all threads, report status

**User says:** "Any new review comments?"
**Action:** Fetch comments, check for updated/new comments since last response, triage only the new ones
