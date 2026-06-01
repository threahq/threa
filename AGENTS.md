# Codex + Claude Interop

Use this bridge file so Codex can reuse existing Claude assets with minimal duplication.

## Shared docs

- `CLAUDE.md` is the single source of truth for project invariants and coding rules.
- Do not duplicate invariants in `AGENTS.md`; keep them only in `CLAUDE.md`.
- Read project guidance from `CLAUDE.md` for coding tasks in this repo.
- Also read global guidance from `~/.claude/CLAUDE.md` when it exists.
- If guidance conflicts, prefer repo-local `CLAUDE.md` for project-specific behavior.

## Skills

- Store project skills in `.agents/skills`.
- Keep `.claude/skills` as a symlink to `.agents/skills` for Claude compatibility.

## Code Review Feedback

CodeRabbit is configured with project-specific rules (`.coderabbit.yaml`) derived from `CLAUDE.md` invariants. Its feedback reflects project standards and must be treated with the same rigor as human review comments.

**Do not dismiss review comments based on perceived severity.** A comment labeled "suggestion", "improvement", or "non-blocking" by a reviewer may still identify a real bug, regression, or spec violation. Evaluate each comment on its technical merit, not its severity label.

For every review comment, assign an explicit disposition:

- **Accept**: The issue is real. Fix it in this PR.
- **Acknowledge**: The issue is real but out of scope. Respond explaining why and what follow-up is planned. Leave the thread open.
- **Dispute**: The issue is incorrect. Respond with the specific technical reason, referencing project invariants or specs.

Never silently skip a comment. Never use language like "just a suggestion", "nice to have", or "not blocking" to justify ignoring valid feedback. If you choose not to fix something, say why explicitly in a thread reply.

When asked to address PR review feedback, use the `respond-to-pr-review` skill for systematic triage.
