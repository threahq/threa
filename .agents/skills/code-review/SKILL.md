---
name: code-review
description: Run multi-perspective code review on a PR or the local branch
allowed-tools: Bash(gh api:*), Bash(gh issue view:*), Bash(gh issue list:*), Bash(gh pr comment:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh repo view:*), Bash(git:*), Bash(mktemp:*), Bash(rm:*)
---

# Multi-Perspective Code Review

Runtime-aware multi-perspective review with inline self-scoring (threshold ≥80/100) and bounded fan-out. Claude may use up to four Sonnet lenses; Pi/OpenAI uses one combined Sol/high reviewer for most diffs and never more than two. The report is ALWAYS printed to chat; PR mode also posts it as a PR comment. One invocation is one review pass—reviewers never delegate, and fixes do not trigger an automatic clean-room rerun.

> **Remote / web sessions:** `gh` is not installed and the GitHub MCP server cannot reliably update existing issue comments (the supersede step in Step 6 silently no-ops). If `gh` fails with "command not found", use the **`github-api-web` skill** for every GitHub interaction in this skill — list/read/post/**PATCH** comments via `curl $GH_TOKEN`. Do NOT fall back to `mcp__github__*` for the supersede flow; it cannot edit prior comment bodies.

## Step 0: Resolve Target & Mode

This skill runs in one of two modes. The default is to review (and post to) the PR the branch is about; only stay local when there is no PR or the user asked you to.

- **PR mode** — review a specific PR, **post the report as a PR comment AND print it to chat**. Use when EITHER:
  - a PR number/URL was provided (e.g. `/code-review 903`) — the explicit target; or
  - no number was given but an **open, non-draft PR exists for the current branch** — the implicit target. Resolve it first:
    ```bash
    # gh (local sessions):
    gh pr view --json number,state,isDraft,url -q '"\(.number)|\(.state)|\(.isDraft)|\(.url)"' 2>/dev/null
    # web/remote sessions (no gh): use the github-api-web skill or GitHub MCP —
    #   GET /repos/OWNER/REPO/pulls?head=OWNER:<branch>&state=open  → take the first open PR
    ```
    If that resolves to an OPEN, non-draft PR, target it and state which PR you picked.
- **Local mode** — review the working branch against its base; **print to chat only, no GitHub posting**. Use ONLY when there is genuinely no open PR for the branch, OR the user explicitly asked to stay local ("the current branch", "this diff", "what I have", "chat-first", "don't post", or iterating before a PR exists).

Precedence: an explicit "stay local" request wins over an open PR. A provided number always wins. Otherwise, if an open PR exists for the branch, use PR mode and post.

Create a private workspace for this invocation before gathering either mode's context:

```bash
mktemp -d "${TMPDIR:-/tmp}/threa-code-review.XXXXXX"
```

Store the printed absolute path as `review_dir`. Every `<review-dir>` below means that exact path; expand it to a literal absolute path in commands and reviewer prompts. Never use a shared `/tmp/code-review*` path.

Resolve the base and diff for **local mode** (PR mode gets its diff from the PR — see Step 2):

```bash
base="${BASE:-main}"
if git rev-parse --verify "origin/$base" >/dev/null 2>&1; then base_ref="origin/$base"; else base_ref="$base"; fi
git diff --quiet "$base_ref"...HEAD && git diff --quiet HEAD && echo "NO_CHANGES" || echo "HAS_CHANGES"
# Committed-since-merge-base (three-dot) + uncommitted working-tree edits (vs HEAD).
# Do NOT diff the two-dot `git diff "$base_ref"`: when origin/main has advanced past
# the branch point it folds that unrelated main-ahead churn into the review and
# produces phantom "this PR also changes X" findings.
{ git diff "$base_ref"...HEAD; git diff HEAD; } > <review-dir>/review.diff
git rev-parse HEAD            # HEAD SHA for links (only clickable if a remote exists)
git branch --show-current
```

Skip the review if `NO_CHANGES` and remove `review_dir`. Otherwise store `base_ref`, the absolute diff path, branch, and HEAD SHA.

## Step 1: Eligibility (PR mode only)

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

**PR mode:**
1. `gh pr view N --json number,title,url,headRefOid,body` — store PR metadata + HEAD SHA
2. `gh repo view --json owner,name` — store OWNER/REPO
3. `gh pr diff N > <review-dir>/review.diff` — the reviewers read this invocation-private file.
4. Plan: extract the `<details>` block under `<summary>📋 Full implementation plan</summary>` from the PR body. Store it or "No plan found".
5. Historical context (single Bash call):
   ```bash
   {
     files=$(gh pr diff N --name-only | grep -v -E '\.test\.|\.spec\.|evals/|\.env|\.md$|\.json$')
     for f in $files; do
       prs=$(gh pr list --state merged --search "path:$f" --limit 3 --json number,title -q '.[] | "#\(.number) \(.title)"')
       [ -n "$prs" ] && printf '=== %s ===\n%s\n' "$f" "$prs"
     done
   } > <review-dir>/history.txt
   ```

**Local mode:**
1. Diff is already at `<review-dir>/review.diff` (Step 0). OWNER/REPO from `gh repo view` or `git remote get-url origin` (best-effort, for links only).
2. Plan: the user's chat is the spec. Distill their intent, constraints, and preferences for the reviewer owning Spec/Design and, for frontend work, the reviewer owning UX. If a PR exists, also pull its body's plan block.
3. Historical context from git (no `gh pr list`):
   ```bash
   {
     mb=$(git merge-base "$base_ref" HEAD)
     git diff --name-only "$base_ref"...HEAD | grep -v -E '\.test\.|\.spec\.|evals/|\.env|\.md$|\.json$' | while IFS= read -r f; do
       hist=$(git log --no-merges --format='%h %s' -3 "$mb" -- "$f" 2>/dev/null)
       [ -n "$hist" ] && printf '=== %s ===\n%s\n' "$f" "$hist"
     done
   } > <review-dir>/history.txt
   ```

In both modes: read agent-instruction files (root AGENTS.md + AGENTS.md/CLAUDE.md in directories touched by the diff). The reviewer owning Spec/Design reads `<review-dir>/history.txt` instead of receiving a pasted wall.

## Step 3: Triage Scope, Select Runtime Profile, Then Spawn

Spawning every lens is the largest avoidable quota drain. Triage first:

```bash
diff=<review-dir>/review.diff
changed_lines=$(grep -cE '^[+-]' "$diff")
sub_files=$(grep -E '^\+\+\+ b/' "$diff" | sed 's#^\+\+\+ b/##' \
  | grep -vE '\.(test|spec)\.|/evals/|\.env|\.md$|\.json$|\.lock$')
sub_count=$(printf '%s\n' "$sub_files" | grep -c .)
fe_count=$(printf '%s\n' "$sub_files" | grep -cE 'apps/frontend/|\.(tsx|jsx|css|scss)$|packages/prosemirror/')
printf 'changed_lines=%s substantive_files=%s frontend_files=%s\n' "$changed_lines" "$sub_count" "$fe_count"
```

Record the active profile, reviewer count, and lens allocation.

### Claude profile

- **Trivial** (`changed_lines` ≤ 50 and `sub_count` ≤ 2): one combined Sonnet reviewer; omit UX/Mobile when `fe_count` = 0.
- **Standard:** Sonnet Agent 1 (Spec & Design) + Agent 2 (Correctness & Data Flow); add Agent 3 (UX) and Agent 4 (Mobile) only when `fe_count` ≥ 1.
- Run agents in the background with `model: "sonnet"`. Maximum four.

### Pi / OpenAI profile

- Use fresh GPT-5.6 Sol reviewers at effort `high`; never `xhigh` in `/code-review`.
- **Trivial or standard:** one combined reviewer covering Spec, Design, Correctness, Data Flow, Security, and—when `fe_count` ≥ 1—UX and Mobile.
- **Large** (`changed_lines` > 1000 or `sub_count` > 20): maximum two reviewers. Backend: Spec/Design/Plan + Correctness/Data Flow/Security. Frontend: first reviewer covers Spec/Design/Correctness/Data Flow/Security; second covers UX/Mobile.
- Never spawn a reviewer per finding, never let a reviewer delegate, and never automatically spawn a post-fix review. A later recheck must be explicitly requested and narrowly scoped to accepted findings.

Each reviewer gets the distilled intent/plan, the absolute `<review-dir>/review.diff` and `<review-dir>/history.txt` paths, and the PR number in PR mode. Pass paths, not pasted diffs.

**AGENTS.md handling:** Do not paste full AGENTS.md into every reviewer. The reviewer owning Spec/Design receives root plus touched-directory instructions. Other reviewers receive only Quick Lookup and: *"Read root AGENTS.md only to confirm a specific invariant before flagging it."*

**Shared instructions** (include in every reviewer prompt):

Do NOT build/typecheck or rerun broad green gates. Read the invocation-private `review.diff` path supplied in the prompt; read source only to push a specific candidate over the ≥80 threshold. Do not browse the tree. Pi/Sol reviewers follow the root `AGENTS.md` read-efficiency rules.

Self-score each issue 0-100 before including it. **Only output issues scoring ≥80.**

Rubric: 0=false positive, 25=maybe/stylistic, 50=real but nitpick, 75=likely real+important, 100=definite+high-impact. AGENTS.md issues: verify cited instruction actually exists and says what you claim (≤25 if misquoted).

```
ISSUES:
- file.ts:10-20 | CATEGORY | SCORE | Description
```

Categories: `claude-md`, `bug`, `plan`, `missing-change`, `abstraction`, `security`, `performance`, `reactivity`, `historical`, `data-flow`, `round-trip`, `state-lifecycle`, `ux-consistency`, `ux-discoverability`, `ux-affordance`, `ux-feedback`, `accessibility`, `mobile-layout`, `mobile-touch`, `mobile-responsive`, `mobile-regression`. No issues → `ISSUES: none`

Do NOT flag: pre-existing issues — UNLESS the diff converts a latent one into a user-visible or data-integrity bug (an issue the change *amplifies* is in scope); unchanged lines (except missing corresponding changes), CI-catchable (types/lint/build), general quality without an AGENTS.md/plan mandate, silenced issues, intentional changes matching PR/chat purpose, theoretical risks — BUT for sync / optimistic-concurrency / event-echo code, an "our own emitted event is delivered back before our ack/commit lands" interleaving is NOT theoretical; if you dismiss a race as rare you must state the timing budget that makes it rare; pedantic nitpicks. Quality over quantity — returning few or no issues is correct when the change is sound.

---

**Agent 1: Spec & Design** (gets full AGENTS.md) — four jobs:
1. **AGENTS.md audit:** Check each change for violations of instructions/invariants. Cite the specific INV-ID, quote the exact rule text, and include the relevant Invariants section title. Only CLEAR violations introduced by this change. Skip: pre-existing, linter-catchable, stylistic.
2. **Plan/intent adherence:** Compare the diff against the plan / the user's stated intent. Missing corresponding changes? (API→frontend, type→usages, schema→migration, backend pref key→frontend wiring). Skip: supporting infrastructure, implementation choices.
3. **Design quality:** Leaky abstractions, config sprawl, partial abstractions, parallel implementations, N+1/unbounded queries, missing memoization / re-render storms, outbox/transaction/reactivity issues. Concrete issues with a named consequence only.
4. **Historical context:** Read the invocation-private `history.txt` path supplied in the prompt (recent commits/PRs per touched file). Only flag changes that clearly violate patterns visible from the history. Do NOT make additional history calls — all of it is pre-provided.

**Agent 2: Correctness & Data Flow** (invariant digest only) — three jobs:
1. **Bug scan:** Logic errors, unhandled edges, off-by-one, null hazards, race conditions, stale-closure/ref bugs, listener leaks, state machines that can wedge. Changes only, significant bugs only. For the riskiest change, mentally execute the primary user sequence step by step rather than reading lines in isolation.
2. **Security:** HIGH-CONFIDENCE vulnerabilities only (>80% exploitable). Trace data flow from user inputs. Categories: injection (SQL/cmd/XXE/template/path traversal), auth bypass, hardcoded secrets, deserialization RCE, XSS, data exposure. **Hard exclusions:** DoS, rate limiting, disk secrets, theoretical races, outdated deps, memory safety, test-only, log spoofing, path-only SSRF, AI prompt content, regex, docs/markdown, missing audit logs, missing hardening without concrete vuln. **Calibration:** React safe unless dangerouslySetInnerHTML. UUIDs unguessable. Env vars trusted.
3. **Data-flow lifecycle** — follow each piece of state through its WHOLE lifecycle, not line-by-line. This is the lens for bugs invisible in a single hunk because the defect is a field dropped, reset, or raced *across* functions and time:
   - **Field round-trip / preservation:** for every persisted or synced entity the diff touches, list each write path (create, update, optimistic confirm, server reconcile, id-migrate, delete). Flag any path that rebuilds a row and silently drops a field another path sets — version / optimistic-lock / sync-status / id / foreign keys / timestamps. The canonical miss: an edit handler constructs a fresh row literal and omits the `version`/`baseVersion` the confirm path wrote, so the next write looks unsynced and collides/duplicates.
   - **Execution simulation:** pick the 2–3 highest-risk end-to-end sequences a user actually drives (e.g. *create → push → server-confirm → edit → push again*, or *reconnect → bootstrap → live event*) and step through them against the code, writing down the entity's fields at each step. A divergence — a field that should be N reading 0/undefined on step 4 — is the finding; cite the concrete sequence.
   - **Invariants first:** before scanning, write down the invariants the entity must hold (e.g. "exactly one row per scope", "loaded XOR stashed", "version monotonic", "field F round-trips every write") and check each sequence against them.
   - **Echo / self-event interleavings:** when the code emits an event delivered back to the same client (outbox → own room, optimistic echo), treat "the echo arrives before the originating call's ack/commit lands" as a DEFAULT ordering and trace what the handler does in it — this is where self-duplication and self-split bugs live.
   Use `data-flow` / `round-trip` / `state-lifecycle` categories for these. Favor concrete sequences ("on the 2nd push expectedVersion is 0 because the edit handler dropped baseVersion") over vague "could race".

**Agent 3: UX / Interaction Design** (frontend diffs only) — user-perceivable behavior, NOT a generic bug hunt:
- **Consistency:** does an interaction behave identically across every surface it appears on (e.g. a gesture wired per-surface that drifts)? Does a documented preference/toggle fully and consistently change behavior everywhere?
- **Discoverability & affordances:** can a user tell what state they're in (focus, mode, selection) and what an action will do before doing it? Is a new capability reachable without already knowing it exists?
- **Affordance gaps & traps:** actions that are hard to reverse, destructive, or land focus/navigation somewhere surprising; empty/loading/error states; flashes, jumps, or content reshape on transition (INV-21 layout shift).
- **Keyboard & a11y-as-UX:** are new shortcuts discoverable and consistent with existing conventions; conflicts; focus management on open/close; can the feature be operated by keyboard alone; are controls labeled.
- **State persistence:** does refresh / back-forward / deep link preserve what the user expects (and is anything silently lost)?
Use the user's voiced preferences (from the plan/chat intent) as ground truth for what "good" feels like here. UX rubric: 0=not a real problem, 25=subjective taste, 50=minor friction, 75=clear friction/inconsistency a real user hits, 100=broken/confusing core interaction or a consistency violation the user explicitly cares about. Favor issues grounded in the actual diff; do not flag pure visual taste or out-of-scope backend work.

**Agent 4: Mobile / Responsive** (frontend diffs only) — user-perceivable on phones/touch/narrow viewports:
- **Correctness of mobile branches:** do `isMobile`/breakpoint paths actually render the intended mobile layout; do viewport-width and container-width thresholds agree (a mismatch where one says "mobile" and another computes a desktop value is a real bug); can the user always get back/out.
- **Touch interactions:** pointer/drag/long-press handlers that interfere with scrolling or tapping; gestures that should be mouse-only but aren't guarded (`pointerType`); controls that are invisible or unusable on touch (hover-only, tiny targets, divider/resize affordances).
- **Layout/viewport:** `vh`/`vw`/`100vh` and fixed widths that break with the mobile keyboard or browser chrome; min-width floors causing horizontal overflow; safe-area handling; regressions to existing mobile keyboard/scroll choreography.
- **Menus/sheets:** do popovers/sheets fit and position correctly on a phone; are desktop-only items correctly hidden on mobile (and vice versa).
Mobile rubric: 0=not real, 25=minor/subjective, 50=minor friction, 75=clear breakage/friction a real phone user hits, 100=core mobile interaction broken. Do not flag desktop-only concerns, theoretical device issues, or things correctly gated behind `isMobile`.

---

## Step 4: Compose Report

Collect all issues from the selected profile's reviewers (1–4). Drop any with score <80. De-duplicate where two agents found the same thing (keep the clearest framing, note both lenses). Verify the highest-impact claims against the source before publishing — a confidently-posted false positive is worse than a missed nitpick; lower the score or drop it if it doesn't hold.

Confidence 1-7: 7=Excellent(none survived), 6=Very Good(minor), 5=Good(few non-blocking), 4=Acceptable(some), 3=Needs Work(multiple), 2=Significant Concerns(blocking), 1=Major Problems.

## Step 5: Re-Check Eligibility (PR mode only)

Re-run Step 1 to ensure the PR hasn't been closed/drafted during review.

## Step 6: Publish

**Always print the full report to chat** (both modes) so the user sees it without leaving the conversation.

Write the final report to `<review-dir>/report.md`; print that exact content to chat. **PR mode also posts the same file** with `gh pr comment N --body-file <review-dir>/report.md`. Link format: `https://github.com/OWNER/REPO/blob/FULL_SHA/path/file.ts#L10-L15` (full SHA, 1-2 lines context). In local mode, use the same link format only if a remote/SHA is known; otherwise cite `path/file.ts:10-15`.

**Attribution:** Disclose models, effort where applicable, and actual lenses. Include `**Review models:** Orchestrator: <runtime model> | Reviewers: <model/effort> x<N> (<lenses>)`, e.g. `sonnet x2 (spec+design, correctness+data-flow)` or `gpt-5.6-sol/high x1 (combined)`.

Report body (identical for the chat printout and the PR comment; the PR comment also carries the `<!-- unified-review -->` marker as its first line):

```
<!-- unified-review -->
### Code review
**Confidence: X/7** — [Label]
**Review models:** Orchestrator: <runtime model> | Reviewers: <model/effort> x<N> (<lenses that ran>)

Found N issues:

1. `file.ts:10-20` — Description (AGENTS.md [INV-XX, <section>]: "<quoted>" | bug: <reason> | ux-consistency: <reason> | mobile-touch: <reason> | etc.)
   https://github.com/OWNER/REPO/blob/SHA/path/file.ts#L9-L21

---
<details><summary>📐 Plan Adherence [CLEAN | N issues]</summary>[details]</details>
<details><summary>🔍 Bugs [CLEAN | N issues]</summary>[details]</details>
<details><summary>🔁 Data Flow [CLEAN | N issues]</summary>[details]</details>
<details><summary>📋 AGENTS.md Compliance [CLEAN | N violations]</summary>[details]</details>
<details><summary>🏗️ Design [CLEAN | N concerns]</summary>[details]</details>
<details><summary>🔒 Security [CLEAN | N issues]</summary>[details]</details>
<details><summary>🎛️ UX [CLEAN | N issues]</summary>[details]</details>
<details><summary>📱 Mobile [CLEAN | N issues]</summary>[details]</details>

🤖 Generated with unified-review automation
<sub>If this review was useful, react with 👍. Otherwise, react with 👎.</sub>
```

**If no issues survived:**

```
<!-- unified-review -->
### Code review
**Confidence: 7/7** — Excellent
**Review models:** Orchestrator: <runtime model> | Reviewers: <model/effort> x<N> (<lenses that ran>)

No issues found. Checked for <the lenses that actually ran — e.g. bugs, data-flow lifecycle, AGENTS.md compliance, plan adherence, design quality, and security on a backend diff; add UX and mobile when those agents ran>.

🤖 Generated with unified-review automation
<sub>If this review was useful, react with 👍. Otherwise, react with 👎.</sub>
```

In local mode, drop the `<!-- unified-review -->` / reaction-footer lines from the chat printout (they only matter on GitHub).

**Supersede old comments** (PR mode, for each active ID from Step 1): Fetch old body, replace `<!-- unified-review -->` with `<!-- unified-review:old -->`, update with `<!-- unified-review:superseded -->`, link to new comment, preserve full old content in `<details>`.

Use `gh api -X PATCH repos/OWNER/REPO/issues/comments/ID -f body=...` locally, or `curl -X PATCH` per the **`github-api-web`** skill in remote/web sessions. **Do not attempt this via `mcp__github__*`** — the MCP server does not expose a working issue-comment edit, and skipping supersede leaves stale reviews stacked on the PR (this is the most common remote-session failure mode for this skill).

After all reviewers have finished and the report/comment is complete, remove only the exact invocation directory returned by `mktemp`: `rm -rf -- <review-dir>`.

## Step 7: Report to User

```
Code review complete — <PR #N: URL | local branch <name> vs <base_ref>>
Confidence: X/7
Models: Orchestrator=<runtime model>, Reviewers=<model/effort> x<N> (<lenses that ran>)
Summary:
- 📐 Plan: <status>
- 🔍 Bugs: <status>
- 🔁 Data flow: <status>
- 📋 AGENTS.md: <status>
- 🏗️ Design: <status>
- 🔒 Security: <status>
- 🎛️ UX: <status>
- 📱 Mobile: <status>
Key issues: [list if any]
```
