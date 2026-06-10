---
name: find-plan
description: Find or deduce the implementation plan for the current feature branch
---

# Find Implementation Plan

Locates and extracts implementation plans for the current feature. Supports finding multiple plans (high-level and substep plans) and combining them into a coherent view.

## What It Does

1. Determines the Claude projects directory for the current worktree
2. Finds ALL plan-related sessions (there may be multiple - main plan + substep plans)
3. Extracts plan content from plan files, plan mode sessions, or discourse
4. Combines plans chronologically with hierarchy indicators
5. Returns structured plan information with source attribution

## Key Insight: Features Often Have Multiple Plans

A feature implementation typically involves:

- **Main plan**: High-level architecture and approach (usually in the earliest session)
- **Substep plans**: Detailed plans for specific components (in later sessions)
- **Course corrections**: Adjustments based on discoveries during implementation
- **Side quests**: Tangential work that emerged during implementation (tooling, process improvements, refactors)

This skill finds and combines ALL of these, clearly marking side quests as separate from the main feature work.

## Understanding Side Quests

Side quests are work sessions that:

- Don't align with the branch name/feature goal
- Improve tooling, process, or infrastructure where that is not the goal of the current feature
- Were triggered by a need discovered during main work
- Are valuable but not part of the feature deliverable

**Example:** On branch `multi-modality-agent-images`, a session improving the `/code-review` skill is a side quest - useful work, but not the multi-modal feature itself.

Side quests should be:

- Acknowledged in the plan output
- Clearly separated from main feature plans
- NOT used for plan adherence checking (they're out of scope by definition)

## Instructions

### Step 1: Determine Claude Projects Directory

```bash
# Get the absolute path to the project root (git worktree root)
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Convert to Claude projects path format
# /Users/foo/dev/project.feature -> -Users-foo-dev-project-feature
CLAUDE_PATH=$(echo "$PROJECT_ROOT" | sed 's/[\/.]/-/g')
PROJECTS_DIR="$HOME/.claude/projects/$CLAUDE_PATH"

echo "Project root: $PROJECT_ROOT"
echo "Claude projects dir: $PROJECTS_DIR"

# Verify it exists
ls -la "$PROJECTS_DIR" 2>/dev/null || echo "Directory not found: $PROJECTS_DIR"
```

### Step 2: Get All Sessions with Metadata

```bash
SESSIONS_INDEX="$PROJECTS_DIR/sessions-index.json"

if [ -f "$SESSIONS_INDEX" ]; then
  # List ALL sessions sorted by creation date with full metadata
  cat "$SESSIONS_INDEX" | jq -r '
    .entries |
    sort_by(.created) |
    .[] |
    {
      id: .sessionId,
      created: .created,
      summary: (.summary // "No summary"),
      firstPrompt: (.firstPrompt[:120] // "No prompt"),
      messageCount: .messageCount
    }
  '
else
  echo "No sessions index found at $SESSIONS_INDEX"
fi
```

### Step 3: Find ALL Plan-Related Sessions

**3a. Find all sessions that used plan mode:**

```bash
PLAN_SESSIONS=""
for jsonl in "$PROJECTS_DIR"/*.jsonl; do
  [ -f "$jsonl" ] || continue

  if grep -q '"EnterPlanMode"\|"ExitPlanMode"' "$jsonl" 2>/dev/null; then
    SESSION_ID=$(basename "$jsonl" .jsonl)
    # Get session metadata from index
    SESSION_INFO=$(cat "$SESSIONS_INDEX" | jq -r --arg id "$SESSION_ID" '
      .entries[] | select(.sessionId == $id) |
      "\(.created) | \(.summary // .firstPrompt[:60])"
    ')
    echo "Plan mode session: $SESSION_ID | $SESSION_INFO"
    PLAN_SESSIONS="$PLAN_SESSIONS $SESSION_ID"
  fi
done
```

**3b. Note: All sessions will be classified semantically**

Sessions with plan-like discourse (even without formal plan mode) will be identified by the Haiku subagent in Step 4b. This provides better accuracy than keyword matching since it understands semantic intent.

**3c. Check the PR description for an existing plan:**

The plan is kept in the PR body inside a collapsible details block (plans are not committed
to the repo — `.claude/plans/` is gitignored). If a PR exists, this is the authoritative
synthesized plan.

```bash
# Pull the plan block out of the current PR's body, if a PR exists
echo "=== Plan in PR description ==="
gh pr view --json body -q '.body' 2>/dev/null | \
  awk '/<summary>📋 Full implementation plan<\/summary>/{f=1} f; /<\/details>/{if(f)exit}'
```

Long-lived design docs under `docs/plans/` are a separate, intentional concern — check them
only if the branch is implementing one of those designs.

**3d. Find plan files written during sessions:**

```bash
# Search ALL session files for plan file writes
echo "=== Plan files written during sessions ==="
for jsonl in "$PROJECTS_DIR"/*.jsonl; do
  [ -f "$jsonl" ] || continue
  SESSION_ID=$(basename "$jsonl" .jsonl)

  # Look for Write tool calls to plan-related files
  PLAN_FILES=$(grep -o '"file_path":"[^"]*"' "$jsonl" 2>/dev/null | \
    grep -iE 'plan|task|design' | \
    sed 's/"file_path":"//g' | sed 's/"//g' | sort -u)

  if [ -n "$PLAN_FILES" ]; then
    echo "Session $SESSION_ID wrote:"
    echo "$PLAN_FILES" | sed 's/^/  /'
  fi
done
```

### Step 4: Extract and Classify Plans

For each plan source found, extract content and classify it.

**4a. Extract plan content:**

Start from the PR description's plan block if it exists (Step 3c) — that's the synthesized
plan. For any plan files written during sessions (found in Step 3d), read those local files
directly for additional context:

```bash
# If a session-written plan file was found, read it
if [ -n "$SESSION_PLAN_FILE" ]; then
  echo "=== Session Plan File ==="
  cat "$SESSION_PLAN_FILE"
fi
```

For plan content embedded in sessions (no separate plan file), use a Haiku agent to extract and summarize:

```
Use the Task tool with these parameters:
  subagent_type: "general-purpose"
  model: "haiku"
  description: "Extract plan from session"
  prompt: |
    Extract the implementation plan from this session's first user message.

    Session ID: [SESSION_ID]
    First user message:
    [FIRST_USER_MESSAGE]

    Extract and structure:
    1. **Requirements**: What the user is asking for
    2. **Key decisions**: Any architectural or design decisions mentioned
    3. **Implementation approach**: Steps or phases if mentioned

    Be concise. Output in markdown format.
```

**4b. Classify sessions using Haiku subagent:**

Use a Haiku subagent to semantically classify each session. This is more accurate than keyword matching because it understands intent and context.

First, gather the classification context:

```bash
BRANCH_NAME=$(git branch --show-current 2>/dev/null || echo "unknown")

# Get main plan summary from the PR description's plan block, if a PR exists
MAIN_PLAN_SUMMARY=$(gh pr view --json body -q '.body' 2>/dev/null | \
  awk '/<summary>📋 Full implementation plan<\/summary>/{f=1} f; /<\/details>/{if(f)exit}' | head -20)

# Get session data for classification
SESSION_DATA=$(cat "$SESSIONS_INDEX" | jq -r '
  .entries |
  sort_by(.created) |
  .[] |
  "SESSION: \(.sessionId[:8])...\nCREATED: \(.created[:10])\nSUMMARY: \(.summary // "N/A")\nFIRST_PROMPT: \(.firstPrompt[:200] // "N/A")\n---"
')

echo "Branch: $BRANCH_NAME"
echo ""
echo "Sessions to classify:"
echo "$SESSION_DATA"
```

Then spawn a Haiku agent for semantic classification:

```
Use the Task tool with these parameters:
  subagent_type: "general-purpose"
  model: "haiku"
  description: "Classify sessions for plan"
  prompt: |
    Classify each session as one of:
    - MAIN: Directly implements the feature described in the branch/main plan
    - SUBSTEP: Implements a specific component of the main feature
    - SIDE_QUEST: Tangential work - tooling, skills, process improvements, unrelated fixes
    - INVESTIGATION: Debugging or exploring an issue related to the feature

    Context:
    - Branch: [BRANCH_NAME]
    - Main plan summary: [MAIN_PLAN_SUMMARY or "See earliest session"]

    Sessions:
    [SESSION_DATA]

    For each session, output ONE line:
    SESSION_ID | CLASSIFICATION | BRIEF_REASON

    Classification guidance:
    - MAIN vs SUBSTEP: Main is the high-level plan; substeps implement pieces of it
    - SUBSTEP vs SIDE_QUEST: Substeps serve the main feature; side quests are valuable but tangential
    - Side quests typically involve: improving skills, updating CLAUDE.md, tooling, process
    - Keyword matches in paths don't count - focus on the actual GOAL of the session
    - A session about "improving /code-review skill" is a side quest even on a feature branch
```

The Haiku agent will return classifications like:

```
bf199dbb | MAIN | Initial multi-modal agent planning with image support
eac9b24f | INVESTIGATION | Debugging large message size issue
43510960 | SUBSTEP | Lazy-loading architecture refinement
a5138566 | SUBSTEP | Passing structured extraction data
bca0ee2c | SIDE_QUEST | Improving find-plan skill (tooling)
```

**4c. Gather additional context from commits:**

```bash
# Commit trajectory provides supporting signal
echo "=== Recent Commits ==="
git log --oneline -15
```

### Step 5: Combine Plans Chronologically

Create a unified view of all plans:

```bash
echo "# Combined Implementation Plan"
echo ""
echo "## Plan Sources"
echo ""
echo "| # | Type | Session | Created | Summary |"
echo "|---|------|---------|---------|---------|"

# List all plan sources
PLAN_NUM=1
cat "$SESSIONS_INDEX" | jq -r '
  .entries |
  sort_by(.created) |
  .[] |
  "\(.sessionId)|\(.created)|\(.summary // "N/A")"
' | while IFS='|' read -r sid created summary; do
  # Check if this session has plan content
  if echo "$PLAN_SESSIONS" | grep -q "$sid"; then
    TYPE=$([ "$PLAN_NUM" -eq 1 ] && echo "Main" || echo "Substep")
    echo "| $PLAN_NUM | $TYPE | ${sid:0:8}... | ${created:0:10} | ${summary:0:40} |"
    PLAN_NUM=$((PLAN_NUM + 1))
  fi
done
```

### Step 6: Identify Course Corrections

Course corrections are identified by the Haiku agent during classification (Step 4b). The agent looks for sessions where:

- The user explicitly changed direction from an earlier plan
- A different approach was taken than originally discussed
- Discoveries during implementation led to plan adjustments

The Haiku agent can identify these semantically rather than relying on brittle keyword patterns like "instead of" or "pivot". When a session is classified, the agent notes if it represents a course correction in the reasoning.

### Step 7: Format Combined Output

Structure the final output:

```markdown
# Implementation Plan for [Feature]

## Overview

- **Feature:** [From branch name or first session summary]
- **Branch:** [git branch name]
- **Plan sources:** [N] main feature sessions + [M] side quests
- **Confidence:** [High if explicit plans | Medium if deduced | Low if sparse]

## Main Plan

**Source:** Session [id] ([date])
**Summary:** [session summary]
**Relevance:** MAIN_FEATURE

### Requirements

[First user message from earliest plan session]

### Approach

[Extracted plan content]

## Substep Plans

### [Substep 1 Name]

**Source:** Session [id] ([date])
**Scope:** [What this substep covers]
**Relevance:** MAIN_FEATURE

[Plan content]

### [Substep 2 Name]

...

## Course Corrections

- **[Date]:** [What changed and why]

## Side Quests (Not Part of Main Feature)

These sessions occurred on this branch but are tangential to the main feature work.
They should NOT be used for plan adherence checking.

### [Side Quest 1 Name]

**Source:** Session [id] ([date])
**Why it's a side quest:** [Doesn't match branch keywords / tooling work / etc.]
**Summary:** [Brief description]

### [Side Quest 2 Name]

...

## Implementation Status

Based on session summaries and commit history:

- [x] Completed items (main feature)
- [ ] Pending items (main feature)
- [x] Side quest: [description]
```

## Output Format

```
FEATURE: [branch name / feature description]
PLANS_FOUND: [N] (main feature) + [M] (side quests)
PLAN_SOURCES:
  main:
    - session:<id> (MAIN)
    - session:<id> (SUBSTEP)
  side_quests:
    - session:<id> - [brief description]
CONFIDENCE: [high | medium | low]

---

[Combined plan content in markdown format, with side quests in separate section]
```

## Example Usage

```
/find-plan
```

## Understanding Plan Hierarchy

**Main Plan indicators:**

- Earliest session chronologically
- Mentions overall feature goal (matches branch name keywords)
- Broad architectural decisions
- Usually triggered by initial user request

**Substep Plan indicators:**

- Later sessions
- References specific component or phase
- Narrower scope ("now let's plan the X part")
- May reference main plan decisions
- Still relates to branch name / main feature

**Side Quest indicators:**

- Session summary/prompt doesn't match branch keywords
- Involves tooling, skills, process improvements
- Triggered by a need discovered during main work
- Valuable but tangential to the feature deliverable
- Examples: improving `/code-review` skill, updating CLAUDE.md, refactoring unrelated code

**Course Correction indicators:**

- Explicit revision language ("instead of", "actually", "change")
- Different approach than earlier plan
- Usually explains WHY the change

## Tips

- **All plan sessions matter:** Don't stop at the first plan - substep plans often contain crucial implementation details
- **Chronological order is meaningful:** Earlier plans set context, later plans refine
- **Look for "let's plan" in user messages:** Often indicates a new planning phase
- **Session summaries are good signals:** They often indicate what was planned vs implemented
- **PR descriptions synthesize plans:** If a PR exists, its description often combines all plans

## Troubleshooting

**Only finding one plan:**

- Check ALL sessions, not just those with "plan" in summary
- Look for sessions with high message counts (indicates substantial work)
- Check for EnterPlanMode in sessions without "plan" in title

**Plans seem contradictory:**

- This is expected - later plans may revise earlier ones
- Present chronologically and note corrections
- The LATEST plan for a specific scope is authoritative

**Can't determine hierarchy:**

- Default to chronological order
- First = main, rest = substeps
- Let the reviewer determine relationships
