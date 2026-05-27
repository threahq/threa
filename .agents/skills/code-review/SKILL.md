---
name: code-review
description: Run multi-perspective code review on a PR
allowed-tools: Bash(gh api:*), Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh pr comment:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh repo view:*)
---

# Multi-Perspective Code Review

3 parallel Sonnet reviewers with inline self-scoring (threshold ≥80/100) → filtered comment.

> **Remote / web sessions:** `gh` is not installed and the GitHub MCP server cannot reliably update existing issue comments (the supersede step in Step 6 silently no-ops). If `gh` fails with "command not found", use the **`github-api-web` skill** for every GitHub interaction in this skill — list/read/post/**PATCH** comments via `curl $GH_TOKEN`. Do NOT fall back to `mcp__github__*` for the supersede flow; it cannot edit prior comment bodies.

## Step 1: Eligibility

```bash
gh pr view <N> --json state,isDraft,author -q '"\(.state)|\(.isDraft)|\(.author.login)"'
```

Skip if: CLOSED/MERGED, isDraft, or bot author (dependabot/renovate/etc).

Check for active unified-review comments to supersede:

```bash
gh api repos/OWNER/REPO/issues/N/comments --jq '[.[] | select(.body | contains("unified-review")) | select(.body | contains("unified-review:superseded") | not) | .id]'
```

Note ALL active IDs — new review supersedes each one.

## Step 2: Gather Context

1. `gh pr view N --json number,title,url,headRefOid,body` — store PR metadata + HEAD SHA
2. `gh repo view --json owner,name` — store OWNER/REPO
3. Find and read CLAUDE.md files (root + directories touched by diff)
4. Find plan **inline** (no agent): Glob for `.claude/plans/`, `~/.claude/plans/`, `*.plan.md`, `plans/*.md`. Read matches. Store plan content or "No plan found".
5. **Pre-compute historical context** via single Bash call (saves ~20 agent tool calls):

```bash
files=$(gh pr diff N --name-only | grep -v -E '\.test\.|\.spec\.|evals/|\.env|\.md$|\.json$')
for f in $files; do
  prs=$(gh pr list --state merged --search "path:$f" --limit 3 --json number,title -q '.[] | "#\(.number) \(.title)"')
  [ -n "$prs" ] && printf '=== %s ===\n%s\n' "$f" "$prs"
done
```

Store output as `historicalContext`. Pass to Agent 3.

## Step 3: Spawn Review Agents

3 parallel Sonnet agents, all `run_in_background: true`, `subagent_type: "general-purpose"`, `model: "sonnet"`. Each gets CLAUDE.md content, PR body, plan (if any), PR number.

**Shared instructions** (include in every agent prompt):

Do NOT build/typecheck. Run `gh pr diff <N>` to get the diff.

Self-score each issue 0-100 before including it. **Only output issues scoring ≥80.**

Rubric: 0=false positive, 25=maybe/stylistic, 50=real but nitpick, 75=likely real+important, 100=definite+high-impact. CLAUDE.md issues: verify cited instruction actually exists and says what you claim (≤25 if misquoted).

```
ISSUES:
- file.ts:10-20 | CATEGORY | SCORE | Description
```

Categories: `claude-md`, `bug`, `plan`, `missing-change`, `abstraction`, `security`, `performance`, `reactivity`, `historical`. No issues → `ISSUES: none`

Do NOT flag: pre-existing issues, unchanged lines (except missing corresponding changes), CI-catchable (types/lint/build), general quality without CLAUDE.md mandate, silenced issues, intentional changes matching PR purpose, theoretical risks, pedantic nitpicks.

---

**Agent 1: Spec Compliance** — Two jobs:
1. **CLAUDE.md audit:** Check each change for violations of instructions/invariants. Cite the specific INV-ID, quote the exact rule text, and include the relevant Invariant Playbook section title. Only CLEAR violations introduced by this PR. Skip: pre-existing, linter-catchable, stylistic.
2. **Plan adherence:** Compare diff against plan/PR description. Missing corresponding changes? (API→frontend, type→usages, schema→migration). Skip: supporting infrastructure, implementation choices.

**Agent 2: Correctness** — Two jobs:
1. **Bug scan:** Logic errors, unhandled edges, off-by-one, null hazards, race conditions. Changes only, significant bugs only.
2. **Security:** HIGH-CONFIDENCE vulnerabilities only (>80% exploitable). Trace data flow from user inputs. Categories: injection (SQL/cmd/XXE/template/path traversal), auth bypass, hardcoded secrets, deserialization RCE, XSS, data exposure. **Hard exclusions:** DoS, rate limiting, disk secrets, theoretical races, outdated deps, memory safety, test-only, log spoofing, path-only SSRF, AI prompt content, regex, docs/markdown, missing audit logs, missing hardening without concrete vuln. **Calibration:** React safe unless dangerouslySetInnerHTML. UUIDs unguessable. Env vars trusted.

**Agent 3: Design** — Two jobs:
1. **Design quality:** Leaky abstractions, config sprawl, partial abstractions, parallel implementations, N+1/unbounded queries, missing memoization, outbox/transaction/reactivity issues. Concrete issues only.
2. **Historical context:** You receive pre-computed `HISTORICAL CONTEXT` showing recent merged PRs per file. Analyze provided PR titles for established patterns. Only flag changes that clearly violate patterns visible from the PR history. Do NOT make additional `gh pr list` or `gh api` calls — all historical data is pre-provided.

---

## Step 4: Compose Comment

Collect all issues from agents. Drop any with score <80.

Confidence 1-7: 7=Excellent(none survived), 6=Very Good(minor), 5=Good(few non-blocking), 4=Acceptable(some), 3=Needs Work(multiple), 2=Significant Concerns(blocking), 1=Major Problems.

## Step 5: Re-Check Eligibility

Re-run Step 1 to ensure PR hasn't been closed/drafted during review.

## Step 6: Post Comment

Use `gh pr comment N --body "..."`. Link format: `https://github.com/OWNER/REPO/blob/FULL_SHA/path/file.ts#L10-L15` (full SHA, 1-2 lines context).

**Attribution:** Disclose models. Include `**Review models:** Orchestrator: <runtime model> | Reviewers: sonnet x3`.

**If issues found:**

```
<!-- unified-review -->
### Code review
**Confidence: X/7** — [Label]
**Review models:** Orchestrator: <runtime model> | Reviewers: sonnet x3

Found N issues:

1. `file.ts:10-20` — Description (CLAUDE.md [INV-XX, <section>]: "<quoted>" | bug: <reason> | etc.)
   https://github.com/OWNER/REPO/blob/SHA/path/file.ts#L9-L21

---
<details><summary>📐 Plan Adherence [CLEAN | N issues]</summary>[details]</details>
<details><summary>🔍 Bugs [CLEAN | N issues]</summary>[details]</details>
<details><summary>📋 CLAUDE.md Compliance [CLEAN | N violations]</summary>[details]</details>
<details><summary>🏗️ Design [CLEAN | N concerns]</summary>[details]</details>
<details><summary>🔒 Security [CLEAN | N issues]</summary>[details]</details>

🤖 Generated with unified-review automation
<sub>If this review was useful, react with 👍. Otherwise, react with 👎.</sub>
```

**If no issues survived:**

```
<!-- unified-review -->
### Code review
**Confidence: 7/7** — Excellent
**Review models:** Orchestrator: <runtime model> | Reviewers: sonnet x3

No issues found. Checked for bugs, CLAUDE.md compliance, plan adherence, design quality, and security.

🤖 Generated with unified-review automation
<sub>If this review was useful, react with 👍. Otherwise, react with 👎.</sub>
```

**Supersede old comments** (for each active ID from Step 1): Fetch old body, replace `<!-- unified-review -->` with `<!-- unified-review:old -->`, update with `<!-- unified-review:superseded -->`, link to new comment, preserve full old content in `<details>`.

Use `gh api -X PATCH repos/OWNER/REPO/issues/comments/ID -f body=...` locally, or `curl -X PATCH` per the **`github-api-web`** skill in remote/web sessions. **Do not attempt this via `mcp__github__*`** — the MCP server does not expose a working issue-comment edit, and skipping supersede leaves stale reviews stacked on the PR (this is the most common remote-session failure mode for this skill).

## Step 7: Report to User

```
Code review posted to PR #N: <URL>
Confidence: X/7
Models: Orchestrator=<runtime model>, Reviewers=sonnet x3
Summary:
- 📐 Plan: <status>
- 🔍 Bugs: <status>
- 📋 CLAUDE.md: <status>
- 🏗️ Design: <status>
- 🔒 Security: <status>
Key issues: [list if any]
```
