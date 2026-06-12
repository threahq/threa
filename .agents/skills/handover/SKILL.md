---
name: handover
description: Write a session handover doc for the next agent picking up this line of work. Use when asked to "write a handover", "hand over", "handoff doc", or at the end of a session whose work continues in a future session.
---

# Session Handover Doc

Produce a dense, self-contained handover document that lets a fresh agent — with none of this session's context — continue the work without re-deriving anything. Output it in a single markdown code block in chat (so the user can paste it into the next session's opening prompt). Do not commit it to the repo unless explicitly asked.

## Core principle

The reader knows the codebase conventions (CLAUDE.md) but knows NOTHING about this session: not what shipped, not what was decided, not what broke, not the user's standing preferences expressed along the way. Every sentence should either (a) save the next agent a search, (b) prevent it from redoing or undoing something, or (c) prevent it from re-asking the user something already settled. Cut anything that does none of those.

## Gather before writing

1. `git log origin/main --oneline -15` and the session's PR(s) — what actually merged, PR numbers, final commit SHAs.
2. The branch state: designated branch name, whether it was reset/merged/deleted, anything unpushed (unpushed work MUST be called out loudly — the container is ephemeral).
3. Re-read the session start: what the task was, which plan/design docs are binding.
4. Scan the conversation for: user decisions (especially AskUserQuestion answers and mid-session reversals), deliberate deviations from plans/docs, review rounds and their dispositions, environment quirks discovered the hard way.

## Structure (adapt, don't pad — omit empty sections)

```markdown
# Handover: <workstream> — <state in five words>, next is <X>

One-line orientation: what this session shipped (PR #s + merge SHAs), where
the designated branch stands. Then **First moves:** numbered, concrete
commands/reads the next agent should do before anything else (reset branch
onto main, read the binding design doc §X, ask the user Y).

## Where we are / What <PR> did
Per merged change: what it does, the load-bearing file paths (path:symbol,
not prose descriptions), and the invariant/finding anchors (INV-x, E2EE-x).

## Decision history (don't relitigate)
Numbered. Every user ruling with its rationale, including reversals
("shipped as A, user then chose B mid-PR — B is what's in main"). Mark
deliberate deviations from design docs so the next agent doesn't "fix" them.

## Open follow-ups (in priority order)
Numbered, each with: what, where (file/section), size, and whether it's
blocked on a user decision (say "ask before doing").

## Review/babysit notes
Reviewer findings + dispositions, rate-limit workarounds, how replies/thread
resolution were done, anything the reviewer "learned" that affects future PRs.

## Workflow notes (re-verified this session)
Only environment facts that were actually confirmed or newly discovered this
session: tooling availability (gh CLI, MCP tools), test-runner quirks per
package, pre-commit duration, monitor/background-task lifetimes, container
restart behavior, expected-vs-real failures (e.g. ECONNREFUSED = no local
DB, environmental). Inherited notes that still held can be carried forward;
drop ones proven stale.
```

## Style rules

- Dense over polished: fragments and inline enumerations are fine here (this doc is for an agent, not prose for a human). Bold the load-bearing words (MERGED, NOT implemented, ASK before coding, NEVER).
- Always cite anchors the next agent can jump to: file paths with symbols, doc sections (§4.2), PR/issue numbers, commit SHAs, invariant IDs.
- State negatives explicitly: things that look wrong but are deliberate, things that were considered and rejected, questions the user left unanswered.
- Calibrate length to session complexity: a one-PR bugfix session needs ~20 lines; a multi-PR phase of a long workstream needs the full structure.
- Never include secrets, tokens, or model identifiers.

## Example

The handover that seeded this skill followed this exact shape; see the "Handover: Agent Runtimes Unification" docs passed between sessions on the agent-runtimes workstream for the target density and tone.
