# Claude Tag vs. Ariadne — competitive deep dive + improvement ideas

_Exploration note, 2026-06-27. Not a spec. Sources at the bottom._

## TL;DR

Anthropic shipped **Claude Tag** (2026-06-23): a persistent `@Claude` teammate that lives **inside Slack**,
with per-channel memory, its own service-account identity, ambient (proactive) mode, and async tasks that
run over hours/days. It replaces the old "Claude in Slack" app.

Claude Tag and Ariadne sit on **opposite sides of the same fork**, and that's good news:

- **Claude Tag deliberately _silos_ memory** per channel/compartment for enterprise security. It explicitly
  "doesn't report from private channels." Its thesis is _governed compartmentalization_.
- **Ariadne deliberately _unifies_ memory** (GAM) across the workspace. Threa's whole thesis is "knowledge
  comes to Slack to die" → so _don't_ let it die in silos.

So we should NOT chase Claude Tag's model. We should (a) double down on the two things it structurally cannot
do — **unified cross-stream memory** and **E2E private thinking** — and (b) steal the two things it does that
Ariadne genuinely lacks today — **proactivity** and **long-horizon async tasks**.

---

## 1. What Claude Tag actually is

| Dimension            | Claude Tag                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Surface**          | Retrofit into Slack. `@Claude` in a channel; replies in threads. Beta, Enterprise/Team only.                                                                                                                                                                                                                                                         |
| **Multiplayer**      | One shared Claude per channel. Everyone sees what it's doing; anyone can pick up where the last person left off. "More like interacting with a teammate."                                                                                                                                                                                            |
| **Identity**         | Its **own service account**, not acting-as-user. Posts as the Claude app, opens PRs as the Claude GitHub App, queries warehouses under an admin-provisioned service account. The access question shifts from "what can this user do?" to **"what can this agent do in this compartment?"** (In DMs it flips and uses _your_ connectors/credentials.) |
| **Memory**           | Builds context per channel over time; **scoped to the channels an admin defines**. Sales-Claude and Eng-Claude don't share memory. Doesn't read private channels.                                                                                                                                                                                    |
| **Proactivity**      | **Ambient mode**: jumps in unprompted to flag things org-wide, follow up on forgotten threads/tasks, keep the team updated.                                                                                                                                                                                                                          |
| **Async**            | Delegate and walk away — schedules and pursues projects **over hours or days**.                                                                                                                                                                                                                                                                      |
| **Admin/governance** | Per-channel identity = own tools, own memory, own **token-spend limit**, audit logs of every action + requester. Disable the identity to revoke everything at once.                                                                                                                                                                                  |
| **Proof point**      | Anthropic routes ~65% of internal code changes through their own version of it.                                                                                                                                                                                                                                                                      |

The genuinely novel idea is the **per-compartment agent identity**: the agent is a first-class actor with its own
permissions, budget, and audit trail, not a proxy for a human. That's an enterprise-security framing.

## 2. The model we chose (and why it's different)

Ariadne today (see `apps/backend/src/features/agents/`):

- **Solo-first, knowledge-base-native.** Scratchpads, not channels, are the entry point. No admin provisioning
  needed — Ariadne works for one person on day one.
- **One data-driven system persona** (`persona_system_ariadne`, Sonnet 4.6), per-workspace customizable via
  `agent_config_overrides` (prompt/model/tools/temperature).
- **Inherits stream access** rather than holding its own identity. Runs with the stream's access scope
  (`computeAgentAccessSpec`), strips out-of-scope refs before the model sees them.
- **Unified GAM memory.** Memos extracted from conversations are workspace-wide semantic knowledge, searchable
  across streams. The opposite of Claude Tag's per-channel silo.
- **E2E enclave variant.** Ariadne runs _inside_ end-to-end-encrypted scratchpads (`apps/enclave/`) with a
  reduced toolset. Claude Tag has no answer to this — it sidesteps private channels entirely.
- **Reactive + bounded.** Companion mode auto-replies to in-stream messages; mention and "Discuss with Ariadne"
  are one-shot. Sessions cap at ~20 loop iterations / ~5 research iterations. No proactive monitoring, no
  multi-day tasks, no scheduling.
- **BYOA** via bot-runtime (Pi, Claude Code) coexists with built-in Ariadne.

**The fork, stated plainly:**

|            | Claude Tag                          | Ariadne                        |
| ---------- | ----------------------------------- | ------------------------------ |
| Memory     | Compartmentalized per channel       | Unified across workspace (GAM) |
| Identity   | Own service account per compartment | Inherits stream access         |
| Privacy    | Avoids private channels             | Runs _inside_ E2E encryption   |
| Entry      | Team/enterprise, admin-provisioned  | Solo, zero-setup               |
| Initiative | Ambient/proactive + multi-day async | Reactive + bounded sessions    |
| Host       | Retrofit into Slack                 | Native knowledge product       |

We win on memory unification, privacy, and solo wedge. We lose on initiative and time-horizon. Everything below
follows from that.

## 3. What the rest of the field is building

- **Dust** ($40M Series B, May 2026) frames it as the **"multiplayer OS for enterprise AI"**: humans and agents
  share one workspace — projects, context, to-dos, notifications, compute. Sequoia's pitch: _"Most enterprise AI
  is single-player: one person, one prompt, no compounding. Dust is building the multiplayer system where agents
  and humans share context."_ 300k+ agents deployed, 70% weekly active, zero churn 2025.
- **Shared-memory multi-agent** is the dominant architecture pattern: short-term scratchpad + long-term
  persistent store, concurrent read/write, continuity across sessions.
- **Ambient agents** are the named 2026 arc: reactive → proactive → autonomous, policy-bound, auditable,
  escalate-to-human. The hard part isn't _more_ memory — it's memory that "encodes the structure of the
  environment well enough that the agent can recognize meaningful deviations from normal." A proactive agent's
  memory has to answer _"what should I notice?"_
- **Governance is table stakes.** Repeated warning across the memory-vendor field: ship **user-facing inspect /
  correct / delete** tooling for memory _at launch_, with retention/deletion policy designed before memories
  accumulate.

The throughline: **"single-player → multiplayer," "reactive → proactive," and "memory you can govern."** Threa is
already multiplayer-capable in substrate and already has governable memory (memos with lifecycle). The missing leg
is proactive.

---

## 4. Suggestions for Ariadne

Tagged **[impact / effort]**. Grounded in current architecture so they're buildable, not generic.

### A. Make her proactive — the single biggest gap

Claude Tag's ambient mode is the headline feature and Ariadne has none. We already have the substrate: GAM
extraction, the `memos:captured` outbox broadcast, contiguity, the queue, tracking tables (INV-57).

1. **Ambient "Ariadne noticed" surface** **[high / large]**
   A proactive lane where Ariadne raises things unprompted: _"This decision contradicts what you concluded in
   #pricing last week,"_ _"This thread has been open 3 days with a question to you,"_ _"Three scratchpads this
   week touched the same topic — want a memo?"_ For a solo PKM tool this is arguably MORE valuable than for a
   team — nobody else is going to notice the contradiction.
   - Build on the memo pipeline: when a new memo is extracted, run a cheap (Haiku) **contradiction/staleness
     check** against semantically-near active memos. Surface hits as a low-priority notification, not a toast
     (INV-63).
   - Memory "should answer _what should I notice?_" — our memos already encode the structural model of the
     workspace, so we're well positioned. Start narrow: contradictions + unanswered @mentions to the user +
     dormant-but-active threads.

2. **Scheduled / recurring Ariadne runs** **[high / medium]**
   _"Every Monday, summarize what moved across my scratchpads."_ _"Ping me when anything mentions the Acme
   migration."_ Cron-style triggers feed the existing persona-agent worker. We already have a queue + scheduler;
   this is a new trigger type (`AgentTriggers.SCHEDULED`) + a small `agent_schedules` tracking table.

### B. Give her a time horizon — long-running tasks she owns

3. **Ariadne Tasks (async, multi-session)** **[high / large]**
   Today a session is bounded and synchronous-ish. Claude Tag pursues projects over days. Introduce a first-class
   **task** entity Ariadne owns: a goal, a plan, a state, a log of attempts, a next-wake time. Store as a tracking
   table (INV-57 — never on core domain entities), drive via the queue, re-enter the agent loop on each wake.
   The "Discuss with Ariadne" scratchpad is the natural UI home — the task lives there, progress streams into the
   trace, and she reports back when done or blocked. This is also what makes BYOA agents and built-in Ariadne feel
   like the same kind of thing.

4. **Follow-up on forgotten threads** **[medium / medium]**
   Cheap, high-delight subset of #3: track threads where the user asked Ariadne something and never came back, or
   where Ariadne flagged a TODO. Re-surface after a quiet interval. Pairs with the ambient surface (#1).

### C. Lean into the moat Claude Tag can't touch

5. **Make GAM memory conversational + editable** **[high / medium]**
   The field's loudest governance demand is inspect/correct/delete. We have memos with a lifecycle
   (draft→active→archived→superseded) and a memory explorer, but no _conversational_ control. Let the user tell
   Ariadne _"forget that,"_ _"that's wrong, X not Y,"_ _"that decision was reversed"_ and have her archive/supersede
   the memo in-band. Turns memory from a black box into something the user steers — and it's a feature Claude Tag's
   opaque per-channel memory structurally lacks.

6. **Cross-stream synthesis as a marquee command** **[medium / medium]**
   _"What have I decided about pricing across everything?"_ Ariadne can answer across all accessible streams;
   Claude Tag's siloed memory cannot. The `workspace_research` tool already does this — promote it to a
   first-class, named action ("Ask across my workspace") instead of an implicit tool the model may or may not
   reach for. Make the differentiator visible.

7. **Market E2E private thinking** **[low / small — positioning]**
   Claude Tag "doesn't report from private channels." Ariadne _thinks with you inside encryption_. This is a
   genuine, demonstrable contrast for the privacy-conscious solo user. Mostly a messaging/docs point, near-zero
   eng cost.

### D. Borrow the good governance bits (mostly for BYOA + future teams)

8. **Per-agent token-spend budget + spend visibility** **[medium / medium]**
   Claude Tag gives each identity a token-spend limit and audit log. We have `agent_sessions` /
   `agent_session_steps` already capturing the trace; add cost accounting and a soft per-persona/per-workspace
   budget with graceful degradation (INV-11: fail loudly, no silent fallback). Matters more as ambient + async
   land (#1–#4) — proactive agents spend money while you sleep, so the budget guardrail should ship _with_ them.

9. **Multiplayer Ariadne in shared streams** **[medium / large — only when channels matter]**
   Claude Tag's multiplayer = one shared agent everyone collaborates with, picking up where others left off.
   Companion mode is already per-stream; in a shared channel that's already "one Ariadne everyone sees." The gap
   is the _handoff_ feel — making her work visible and resumable by any member. Defer until team chat is real
   (solo-first per CLAUDE.md), but the substrate (broadcast trace, INV-61 contiguity) is already there.

### E. Small, cheap polish

10. **Persona-level proactivity toggle** **[low / small]** — extend the Companion/Quiet toggle to
    Quiet / Reactive / Ambient, so proactivity (#1) is opt-in per stream. One enum, no new surface.
11. **"Why did you say that?" provenance on every Ariadne reply** **[low / small]** — she already carries source
    ids; expose a one-tap "based on these 3 memos / 2 messages." Deepens trust, leans on existing trace data.
12. **Let Ariadne propose memos, not just auto-extract** **[low / small]** — _"Want me to remember this as a
    decision?"_ inline. Makes capture feel collaborative and corrects extraction misses.

---

## 5. Recommendation

Don't rebuild Ariadne in Claude Tag's image — the compartmentalized-identity, retrofit-into-Slack model is the
wrong shape for a solo-first knowledge product, and copying it would surrender our two real advantages.

Sequence:

1. **Ambient "Ariadne noticed" (#1) + scheduled runs (#2)** — closes the proactivity gap, which is the one place
   Claude Tag is unambiguously ahead, and is _more_ compelling solo than in a team.
2. **Conversational memory control (#5)** — cheap, on-thesis, answers the field's loudest governance demand, and
   widens the moat.
3. **Ariadne Tasks (#3)** — the heavy lift that gives her a time horizon and unifies built-in + BYOA.
4. Ship **token budgets (#8)** alongside #1/#3 so proactive spend has a guardrail from day one.

The cheap wins (#7, #10–#12) can ride along anytime.

---

## 6. Deep dive: Ariadne as dispatcher, local agents as executors

The idea that excites us most, and that no competitor is positioned to do: **Ariadne doesn't execute the heavy
work — she _delegates_ it to the local agent the user already pays for** (Claude Code, Pi), handing over a brief
assembled from the entire workspace's memory. Ariadne is the cheap, always-on, GAM-rich **dispatcher**; the local
agent is the capable **executor**.

### Why this is the right division of labor

- **Cost asymmetry.** Noticing + briefing is cheap and is Ariadne's strength. The expensive multi-step agentic
  loop runs on the user's _own_ subscription (Claude Code Max, etc.), not our inference bill. The customer base
  we target already holds these subscriptions — delegating to a less-capable, more-expensive hosted agent when a
  more-capable local one is sitting idle is the wrong trade.
- **Capability asymmetry.** The local agent has the real environment — repo, filesystem, shell, the user's actual
  tools and credentials. Ariadne is read-mostly and sandboxed. (This mirrors Claude Tag's one genuinely smart
  identity decision: in DMs it acts with _the user's_ credentials, not a service account. Local execution is that
  by construction.)
- **The brief is the product.** A cold `claude` session has zero context. Ariadne hands it a brief built from
  unified GAM — relevant memos, the source thread, prior decisions, linked issues. That is exactly the thing a
  local agent can never assemble alone, and that Claude Tag's _siloed_ memory structurally cannot produce either.
- **It unifies our two halves.** Built-in Ariadne and BYOA stop being alternatives and become one loop:
  **notice → brief → delegate → execute → report → capture.** The executor's output posts back into a stream,
  normal memo extraction runs, and execution becomes durable workspace knowledge. The flywheel closes — and the
  compounding is something Claude Tag (siloed memory, no BYOA) can't replicate.

### The substrate already exists (this is mostly wiring, not a redesign)

The bot-runtime is already a **pull-based task queue**, which is exactly the right model — it decouples Ariadne's
noticing from whether a local agent happens to be online (subscription users run them intermittently):

- `bot_invocations` is the task table: atomic claim (`FOR UPDATE SKIP LOCKED`), claim TTL + renew, bounded
  retries (`BOT_CLAIM_MAX_ATTEMPTS=5`), `pending → claimed → completed/failed` lifecycle.
  (`apps/backend/src/features/bot-runtimes/repository.ts`, `service.ts:416` `createInvocation()`)
- Claude Code & Pi already **claim** work, **renew**, post **trace steps**, and **complete** with a reply +
  **sources** — over Socket.IO with HTTP fallback. (`extensions/bot-runtime-client/src/transport.ts`)
- The **context-bag** system already assembles rich Markdown briefs (GAM memos + quoted messages + decisions) —
  it's just wired to Ariadne/companion today, not to bot handover.
  (`apps/backend/src/features/agents/context-bag/`)
- A recent fix (N-4) already inlines the last ~25 messages into the claim response, so the brief has a delivery
  channel. (`apps/backend/src/features/public-api/handlers.ts:467`)
- Bots already declare **traits** (`mentionable`, `active-scratchpad`) and **presence** (Available/Busy/Offline).

So the gap from today to "Ariadne briefs a task → local Claude Code claims it with full GAM context → executes →
reports back → becomes a memo" is small and additive.

### What's actually new

1. **`delegate_task` tool for Ariadne** _(small)_ — calls the existing `createInvocation()` with a new
   `trigger: "delegation"`. Inputs: target agent slug (or "any available executor"), task brief, context refs
   (stream / messageIds / memoIds). This single tool is the seed — even with nothing else, the user can say
   "hand this to my local agent" and it works.
2. **`DELEGATE_TASK` context-bag intent** _(small–medium)_ — assembles the handover brief: goal + acceptance
   criteria (Ariadne writes these), relevant GAM memos, the source thread window, attachments, external refs
   (GitHub/Linear). Delivered via the existing N-4 claim-context channel, extended with a structured brief field.
   **This is where the moat shows up — invest here.**
3. **"Handoffs" inbox surface** _(medium)_ — a user-facing lane listing pending/claimed/done tasks. The queue
   already persists work; this makes it visible and lets an agent that connects later drain the inbox. INV-63:
   surface here, don't toast.
4. **`task-executor` trait** _(small)_ — a bot opts in to claiming delegation invocations. Keeps it explicit and
   opt-in; reuses the existing claim path.
5. **Status correlation** _(small, mostly reuse)_ — invocation status + response message + sources + trace
   already exist; surface them as task status in the inbox, post the result back into the originating scratchpad,
   and optionally let Ariadne fold the result into her next turn.

### Sequencing

- **MVP — user-triggered handover** (#1, #2, #3-lite, #4). Right-click a message or ask Ariadne → she builds the
  GAM brief → invocation queued → local agent (now or on next connect) claims, executes, completes → result posts
  back and becomes a memo. No ambient mode required. This alone is the "extremely easy handover" we want.
- **V2 — ambient generation.** Ambient Ariadne (§4 #1) drops task _proposals_ into the Handoffs inbox; one-tap
  approve → dispatch. Proactivity and delegation compose cleanly.
- **V3 — routing & autonomy.** Route a task to the right agent by repo/skill/availability; full delegation audit
  trail (who briefed, who claimed, what it did); optional auto-dispatch under a token budget (§4 #8).

### Decisions to flag before building

- **Brief access scope.** The brief must be scoped to what the _requesting user_ can access (they own the local
  agent and its creds), not Ariadne's stream scope. Resolve the brief against user access, not persona access.
- **E2E boundary.** Delegation from an E2E scratchpad can't egress plaintext to a server-built brief. The sealed
  invocation machinery exists but `externalSealedDelivery` is off. MVP: disable delegation from E2E streams (or
  limit it to the in-enclave window) and revisit with the sealed wire.
- **Pull-first.** The inbox/claim model is primary (survives offline agents). Direct push to a live-linked agent
  is an optimization, not the foundation.
- **No spam.** Proactively generated tasks are _proposals_ until the user approves (or until V3 + a budget makes
  auto-dispatch safe).

---

## Sources

- [Introducing Claude Tag — Anthropic](https://www.anthropic.com/news/introducing-claude-tag)
- [Anthropic's Claude Tag gives AI agents independent identities — Help Net Security](https://www.helpnetsecurity.com/2026/06/24/anthropic-claude-tag-agent-identity-model/)
- [Anthropic's Claude Tag is learning your company, one Slack message at a time — TechCrunch](https://techcrunch.com/2026/06/23/anthropics-claude-tag-is-learning-your-company-one-slack-message-at-a-time/)
- [Claude Tag embeds Anthropic's AI in Slack… — The Decoder](https://the-decoder.com/claude-tag-embeds-anthropics-ai-in-slack-already-writes-65-percent-of-internal-code-company-says/)
- [Anthropic gives @Claude a permanent seat in your Slack channels — The New Stack](https://thenewstack.io/anthropic-claude-tag-slack/)
- [Dust raises $40M Series B to build the "multiplayer" OS for enterprise AI — Tech.eu](https://tech.eu/2026/05/18/dust-raises-40m-series-b-to-build-the-multiplayer-operating-system-for-enterprise-ai/)
- [The memory problem changes when agents stop waiting to be prompted — Barr Moses, Medium](https://medium.com/data-science-collective/the-memory-problem-changes-when-agents-stop-waiting-to-be-prompted-5a2939200fcf)
- [State of AI Agent Memory 2026 — mem0](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [The Rise of Ambient Agents — Curious Compass](https://curiouscompass.substack.com/p/ambient-ai-enterprise-invisible-ai-agents)
