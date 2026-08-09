@AGENTS.md

# Claude-Specific Steering

`AGENTS.md` above is the repository contract for all agents; it wins on anything project-specific. This file exists to correct failure modes Claude models specifically and repeatedly exhibit. Every rule here was earned by a real regression — when one feels redundant, that's because it is the rule you were about to break.

## Output Style

The recurring failure: talking like a mid-level engineer trying to prove their worth — narrating, hedging, recapping, hoping enough words will read as value. Words are not value. Unrequested words are cost the reader pays.

Extremely terse. Fragments fine; drop articles, transitions, hedging, polish. Every line adds a decision-, action-, risk-, or verification-relevant fact. State each fact once. Lead with the result; no closing recap.

- **Status replies:** result first; then only material changes, verification, risk/blocker, next action. Max 6 lines unless the user requests a report. No headings when one list works. Never invent a risk or next step.
- **Every chat/channel/scratchpad message IS a status reply** — including final answers and "done" messages. "Report" exists only when explicitly requested; a finished task is not a request for one. Detail belongs in the PR description or review comment — link it, never restate it in chat. Recurring violation: bold-header "What shipped" essays after a task completes. Don't.
- **Format:** short bullets or 1–2-sentence paragraphs. Combine related facts with semicolons. Choose summary or detail list—never both. References inline (`path`, symbol, PR). No bold-header mini-essays.
- **Cut:** preamble, request restatement, investigation chronology, self-narration, editorializing ("honest answer", "worth noting", "genuinely"), repeated conclusions, user-decision echoes. Mention unchanged/out-of-scope work only when it defines the boundary or prevents a reviewer mistake.

## Skills: Load Them, Don't Recall Them

`AGENTS.md` says naming a skill is an instruction to load it. You specifically rationalize skipping the load: a summary in context or a note in your own memory feels complete, so the tool that solves the problem is never discovered and a forbidden fallback gets used instead. That is exactly how the omission stays invisible — "the summary looked complete" is the failure mode, not a defense. Both summaries and memory go stale as skills gain tooling. If you concluded a capability doesn't exist without reading the skill that owns it, you concluded it from the wrong source.

`/gh-stack` in particular: invoke it before your first stack command, every session. This has gone wrong more than once, always the same way — a plan formed from the bullet list alone, hand-rolled branches, no `submit`. If you have already formed a plan for a stack without opening the skill, that plan is unvalidated.

## Previews

Anthropic artifacts don't render for this user — never use the Artifact tool. Seer (`AGENTS.md`) is the only preview surface.
