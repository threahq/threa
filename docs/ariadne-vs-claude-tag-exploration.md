# Ariadne vs. Claude Tag: research + improvement proposals

Exploration note, 2026-07-02. Sources: web research sweep (adversarially verified, citations inline) + full codebase map of the agent runtime. Companion to `docs/features/architecture/agent-runtime.md`.

## 1. What Claude Tag is

Claude Tag is Anthropic's Slack-embedded "multiplayer" agent surface, launched in beta **June 23, 2026** for Claude Enterprise and Team customers. It replaces the prior Claude-in-Slack app (existing workspaces force-migrate August 3, 2026). Teams tag `@Claude` as a collaborative team member; admins grant it access to selected channels and connect it to chosen tools, data, and codebases. ([announcement](https://www.anthropic.com/news/introducing-claude-tag))

Anthropic's Cat Wu (head of product, Claude Code and Cowork) frames it explicitly as "an evolution of Claude Code" from single-player to multiplayer: Claude Code/Cowork/chat are single-player surfaces; Tag is the interactive multiplayer one.

Core design facts (all verified 3-0 against primary sources):

- **One shared Claude per channel**, not per-user sessions. "Within a given Slack channel, there's one Claude that interacts with everyone." Sharing is per-channel, not company-wide: private channels get a distinct Claude identity; public channels share a workspace-level identity. The hierarchy is three levels — organization → workspace → channel.
- **Long-horizon by design.** Given a task it breaks it into stages and works autonomously over hours or days, including self-scheduled tasks. All work is visible in the channel so anyone can observe, jump in, redirect, or pick up where the last person left off.
- **Passive-following memory.** "@Claude learns over time. As Claude follows along with its channel, it builds more context about the work." Memory is strictly partitioned along admin-defined channel boundaries; a sales-configured Claude won't pass memories to an engineering one, and private-channel knowledge never surfaces workspace-wide. Cross-channel learning is explicit admin opt-in. Admins can audit, edit, and delete channel memory.
- **Agent identity is the flagship architectural change** ([agent identity blog](https://claude.com/blog/agent-identity-access-model)). Claude holds its own admin-provisioned service accounts (posts as the Claude Slack app, opens PRs as the Claude GitHub App) rather than borrowing any user's credentials — resolving the "whose permissions apply?" ambiguity in multi-user channels. Admins define a baseline identity at workspace level; channels inherit and can override. An **Agent Proxy** keeps credentials in a store the model and sandbox never see, injects them at the network boundary at request time, and enforces a default-deny outbound-host allowlist.
- **Model: Claude Opus 4.8** (released May 28, 2026), Anthropic's most capable public model.

### The model-choice question, answered

Suspicion confirmed: Tag runs **Opus 4.8**; Ariadne runs **Sonnet 4.6** at temp 0.7 (`built-in-agents.ts:63`), with Haiku 4.5 for summaries/digests/validation and GPT-5.4-mini for the GAM memo pipeline.

This is not an oversight to fix by copying — it follows from divergent product bets:

- **Tag** sells autonomous multi-hour execution to Enterprise, priced accordingly. Long-horizon autonomy compounds errors, so it needs the top model.
- **Ariadne** is a fast conversational companion for solo/small-team users. Sonnet's latency and cost fit a "responds in seconds, many times a day" pattern; Opus everywhere would wreck unit economics at our price point.

The improvement isn't "switch to Opus" — it's **escalation tiering** (§5.1): keep Sonnet for conversational turns, escalate the hard research/synthesis turns.

## 2. What others are building

**OpenAI workspace agents** (announced April 22, 2026, research preview for Business/Enterprise/Edu) converge on the same pattern from the other direction: org-shared agents evolving custom GPTs, powered by Codex, running in the cloud with a persistent workspace (files, code, tools, memory). They deploy into Slack channels, pick up requests asynchronously, respond in-channel. Memory is **correctable in conversation** ("build once, improve through use, then share or duplicate") — agents improve as teams use them. ([announcement](https://openai.com/index/introducing-workspace-agents-in-chatgpt/))

**Collaborative Memory** (Accenture Center for Advanced AI, [arXiv 2505.18279](https://arxiv.org/html/2505.18279v1)) — first formalization of multi-user LLM-agent memory with asymmetric access: two-tier memory (private ∪ shared), write policies routing user-specific insights to private and de-personalized knowledge to shared, and visibility via time-evolving bipartite permission graphs with fragment provenance for retrospective permission checks. This is a direct blueprint for GAM's next steps — Threa's `checkStreamAccess`/INV-62 inheritance model is already the permission substrate the paper assumes.

**Claude Code delegation patterns** (source analysis of v2.1.88, [arXiv 2604.14228](https://arxiv.org/html/2604.14228v1)): subagents run in isolated context windows and return **only summary text** to the parent, never full history; the context window is treated as the binding resource with five layered reduction strategies executing cheapest-first before every model call. Our `workspace_research`/`general_research` sub-loops already follow the summary-only pattern.

**Convergent takeaways** (both vendors independently arrived here):

1. One shared agent per channel/stream, work visible in the timeline, any member can steer or resume.
2. Memory scoped to the access boundary of the surface it was learned in; cross-scope learning is explicit opt-in.
3. Agent has its own identity with per-scope permission inheritance/overrides; credentials live at a boundary the model never touches.
4. Long tasks delegate to sub-workers that return summaries only.

Threa already has 1 (one session per stream, trace card, new-message reconsideration), most of 2 (access-scoped retrieval via `computeAgentAccessSpec`), the skeleton of 3 (personas author as `AuthorTypes.PERSONA` with explicit `accessibleStreamIds`, never user credentials — we independently built the same answer to "whose permissions apply"), and 4 (researcher sub-loops). The gaps are what follows.

## 3. Ariadne today (grounding)

Full map in `docs/features/architecture/agent-runtime.md`. The load-bearing facts for the proposals:

- Persona record (`persona_system_ariadne`) on a host-agnostic runtime (`packages/agent-runtime`); outbox-triggered, three-phase sessions (INV-41), ≤20-iteration tool loop, one running session per stream (partial unique index), in-flight `NewMessageAwareness` folds follow-ups, supersede reruns on edits.
- ~20 tools, **all read-only**, three-layer gating (persona `enabledTools` → integration deps → `stream_policies`).
- GAM is passive: background extraction (gpt-5.4-mini classifier + memorizer), hybrid pgvector+FTS retrieval with RRF + structural boost + nano reranker. Ariadne reads GAM via `workspace_research`/`describe_memo`; she never writes it.
- Short-term memory = rolling conversation summary + turn digests + context bag, rebuilt per turn. No durable per-stream or per-user agent memory.
- **Purely reactive** — acts only on a triggering message. No self-scheduling, no ambient awareness, no write actions.
- External bot runtime (WebSocket, `ExternalTurnDriver`, public API, trust tiers) already exists and shares the turn-driver seam; `extensions/claude-code-remote/`, `pi-remote/`, `harness-daemon/` already exist.

## 4. Improvement proposals

Ordered by axis, each tagged **[S]**mall / **[M]**edium / **[L]**arge.

### 4.1 Runtime: from answerer to team member

**(a) Self-scheduling / follow-ups [S — highest leverage-to-effort].** "I'll check back tomorrow" is the single cheapest team-member behavior. The `scheduled-messages` feature already exists; add a `schedule_follow_up` tool that enqueues a future self-invocation (a scheduled message authored by the persona that re-triggers her with the original context pointer). Tag's "self-scheduled tasks" is exactly this. Bound it: max N pending per stream, visible as a card so users can cancel.

**(b) Passive following, bounded [M].** Tag's stickiest property is that it "follows along" so you stop re-explaining context. Ariadne's equivalent shouldn't be replying more — it should be a cheap ambient pass on companion-on streams that maintains the stream brief (§4.3b) and occasionally surfaces value: an unanswered question aging past a threshold, a relevant memo when a topic recurs, a contradiction with a recorded decision. Use a Haiku-class classifier per settled conversation (piggyback the existing memo-batch settlement signal — the debounce/settlement plumbing already exists). Model-based, not keyword heuristics (INV-54). Strict budget: at most one proactive surfacing per stream per day, rendered as a dismissible timeline card, off by default outside scratchpads.

**(c) Steerability affordances [S].** The machinery exists (`NewMessageAwareness`, abort registry) but is invisible. Put "Redirect" and "Stop" actions on the live activity card — redirect just focuses the composer (the loop already folds new messages in and reconsiders), stop wires the existing abort registry beyond research tools. Anyone in the stream can do both; that's the multiplayer feel Tag markets, and we're two UI affordances away from it.

**(d) Model escalation tiering [S].** Per-turn model resolution instead of one static persona model: Sonnet 4.6 default; escalate to Opus-class when (i) the user asks ("think hard about…"), (ii) the turn dispatches `general_research`, or (iii) a supersede rerun failed validation. The persona config already resolves per-turn (`ContextWindowPolicy` precedent); this is a config-shape change, not a runtime change. Also consider Opus for the researcher's evaluator step only — the planner/searcher can stay cheap.

**(e) Surface the persona picker [S].** Workspace personas are code-complete (`applyBuiltInAgentPatch`, `agent_config_overrides`) but have no UI. Tag validates per-scope identity: a channel-specific persona (name, prompt, tool set) is how "the legal channel's agent" differs from "the eng channel's agent." Shipping the picker also makes the BYO-bot story legible — first-party personas and external bots appear in the same chooser.

### 4.2 Tools

All current tools are read-only. The step-change is a small set of **write tools inside Threa** (not external side effects), each visible in-timeline:

- **`save_memo` [M]** — agent-authored memos. See §4.3a.
- **`schedule_follow_up` [S]** — §4.1a.
- **`create_thread` / `create_scratchpad` [S]** — "let's take this to a thread" / "I've set up a scratchpad for the migration plan." Pure Threa writes, trivially reversible, high collaborator feel.
- **`update_stream_brief` [M]** — §4.3b.
- **`delegate_task` [M]** — §4.5.
- External writes (create Linear issue, GitHub comment) **[M, later]** — only behind an explicit per-action user confirmation card, and note Tag's lesson: when we do this, the action should come from a Threa/Ariadne app identity, never a user's OAuth token. Our integrations are currently read-only OAuth/App installs; keep it that way until there's a confirmation UX.

Also **[S]**: extend cooperative cancellation (`toolSignalProvider`) beyond the two research tools — any tool that can take >2s should honor abort.

### 4.3 Memory: complementary systems to GAM

GAM is episodic→semantic extraction: passive, conversation-sourced, workspace-shared (access-scoped). Three complementary stores are missing, and the Collaborative Memory paper's private/shared split maps cleanly onto them. All three should reuse the existing access substrate (`computeAgentAccessSpec`, INV-62) and the memory-capture-visible rule (INV-62 capture events) — agent memory writes are never silent.

**(a) Agent-authored memos [M].** Two write paths into the existing `memos` table: explicit ("Ariadne, remember this") and reflective (at session completion, if the turn's research produced durable knowledge — the turn-digest step already condenses tool work; today that value evaporates when the digest ages out). Mark provenance (`memoType: 'agent'`, source session id), same embedding/dedup pipeline, same `memos:captured` timeline event. Guard against self-reinforcement: agent memos rank below conversation-sourced memos in the structural boost, and the reflective path uses the classifier's confidence floor.

**(b) Durable stream brief [M — the big one].** Tag's channel memory and Claude Code's CLAUDE.md are the same object: a persistent, human-auditable working document per scope. Add a per-stream brief Ariadne maintains — goals, open questions, decisions in force, preferences, glossary. Unlike the rolling summary (ephemeral, rebuilt per turn), the brief is durable, versioned, and **user-editable**: rendered in stream settings next to the existing custom instructions, injected into the system prompt each turn. Correctability is the trust mechanism both vendors converged on ("admins can audit, edit, delete"; "guided and corrected in conversation") — "that's wrong, we chose Postgres" → she edits the brief, and the edit is a visible timeline event. This directly attacks re-explaining context, the top companion friction.

**(c) User preference memory [M].** Per-user private-tier memos (tone, stack, timezone, current focus) following the paper's write policy: user-specific insights → private store (visible only in that user's scratchpads/DMs), de-personalized knowledge → shared GAM. Concretely: `memoScope: 'user' | 'stream' | 'workspace'` on the memos table, retrieval filters by scope + existing access spec. A user-visible "what Ariadne knows about you" panel in the memory explorer, with delete.

**(d) Memory hygiene loop [S].** The memory explorer exists (`?memo=`); add edit/archive from it, plus retrieval feedback: when a cited memo gets a 👎 (or a correction message), decay its structural boost. Closes the loop that keeps shared memory trustworthy as it grows.

### 4.4 Session management

- **Episode summaries [S].** Turn digests carry within the context-window policy; persist a compact per-session episode summary (haiku, same pipeline as the rolling summary) keyed to stream + date, retrievable by `workspace_research`, so "as we discussed last week" resolves even after the window has scrolled past. Cheap because the summarization machinery exists.
- **Per-thread session granularity [S].** One-running-session-per-stream serializes a busy channel and its threads. Scope the partial unique index to the addressed stream (thread vs root) — threads already resolve companion mode through the root, but sessions needn't serialize across them.
- **Deliberately no long-horizon sessions [decision, not feature].** Tag's hours-long autonomous stages are exactly what we should _not_ build (cost, babysitting, error compounding on our price point). Sessions stay minutes-bounded; anything longer becomes a delegation (§4.5) or a scheduled follow-up (§4.1a). Write this down as a product invariant so it survives feature pressure.

### 4.5 Local agent delegation

The strategic position: **Threa is the shared-memory and coordination plane; the user's local agent is the execution plane.** Tag needs the Agent Proxy and agent-identity apparatus because execution happens in Anthropic's cloud with the agent's own credentials. Flipping execution to the user's machine dissolves that problem instead of solving it — the local agent runs with the user's credentials, their sub (marginal cost ≈ 0 for our audience), and their repo/filesystem context, which we'd otherwise have to integrate our way toward. This is a defensible differentiator against Tag, not a budget workaround.

The repo already has most of the pipe: bot runtime with `ExternalTurnDriver` + WebSocket, public API with the sealed claim/complete pattern, `extensions/claude-code-remote/`, `pi-remote/`, `harness-daemon/`.

Proposed shape:

1. **`delegate_task` tool [M].** Ariadne packages a delegation: task brief + curated context (relevant messages, memos, attachment links — she does the expensive context assembly with `workspace_research`; this is the half of the job where _we_ have better context than the local agent). Output is a **delegation card** in the timeline: title, brief, claim state.
2. **Task lifecycle tracking [M].** Tracking table (INV-57 — not state on messages): `delegated_tasks` with status pending/claimed/running/done/failed, claimant, result message id. The local agent claims and reports via the public API — the bot-runtime sealed claim/complete pattern is the template. Everyone in the stream sees who claimed it and its live status: delegation is multiplayer-visible, like everything else.
3. **Hand-off UX [S→M].** Card actions: _Copy prompt_ (compiled brief, zero-integration path that works day one), _Run locally_ (deep link the `claude-code-remote` extension picks up), or claim via API for headless harnesses. Start with copy-prompt; ship the extension path second.
4. **Threa MCP server [M].** A small `@threa/mcp` package wrapping the public API (search messages/memos/streams, read attachments, post message, update delegation status) so any local agent — Claude Code, or whatever the user runs — pulls Threa context itself and posts results back. This makes the delegation loop closed: local agent finishes → posts to the stream → GAM memorizes the outcome → the knowledge is shared. One integration on our side covers every local agent instead of us integrating everywhere.
5. **Positioning vs BYO bots [docs/S].** Bots = persistent third-party agents living in the workspace; delegation = one-shot hand-off to a _person's_ agent. Same seam (public API), different lifecycle. Worth one paragraph in `docs/features/public/` so the two stories don't blur.

## 5. Prioritized shortlist

Quick wins (ship independently, each small): `schedule_follow_up` (4.1a) → steer/stop affordances (4.1c) → model escalation (4.1d) → persona picker (4.1e) → episode summaries (4.4) → memory-explorer edit/archive (4.3d) → copy-prompt delegation card (4.5.3 minimal).

Big rocks, in order of differentiation-per-effort:

1. **Durable stream brief** (4.3b) — the single feature that most closes the gap to Tag's "it follows along," and it's correctable memory, the trust mechanism both vendors converged on.
2. **Delegation pipeline** (4.5.1–2, then 4.5.4) — the strategic bet nobody else is making; Tag and OpenAI both went cloud-execution, we go local-execution with shared memory.
3. **Agent-authored + scoped memos** (4.3a, 4.3c) — completes GAM into the two-tier private/shared architecture the research literature says this converges to.
4. **Bounded passive following** (4.1b) — last, because proactivity done wrong erodes trust fastest; ship it after the brief exists so ambient work has somewhere durable to land.
