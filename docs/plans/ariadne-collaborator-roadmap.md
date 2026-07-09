# Ariadne Collaborator Roadmap

Working plan for the improvements proposed in `docs/ariadne-vs-claude-tag-exploration.md`. Read that doc first — it holds the research, the rationale, and the prioritization. This doc is the execution tracker: high-detail step descriptions, grounded in the code as of 2026-07-02, checked off as work lands.

## How to use this doc

- **One step = one PR, and each step is a logical unit.** A step must deliver an observable behavior change or a complete user-facing surface — a bare table or endpoint with no consumer is not a step. A tool ships together with its underlying infra (schema, service, worker) in one PR; administrative surfaces (config knobs, settings UI) are their own step. Steps within a phase are ordered by dependency; phases are mostly independent (dependencies called out per phase).
- **Workflow per step:** branch from main → implement → run the step's test list → `/create-pr` referencing this doc and the step id (e.g. `feat: schedule_follow_up tool (roadmap 1.1)`) → check the box here with the PR number in the same PR.
- **Keep this doc honest.** If implementation diverges from a step's Shape, edit the step in the same PR and note the deviation. A stale plan is worse than none.
- File references are `path:line` as of the commit this doc landed in; expect drift, trust symbols over line numbers.

## Standing constraints

These recur across every step; the step descriptions assume them rather than restating:

- Real-time delivery via outbox (INV-4); projections committed with events (INV-7). New tables are workspace-scoped (INV-8), prefixed ULIDs (INV-2), no FKs/enums (INV-1/3), append-only migrations (INV-17).
- No DB connections held across AI/network work (INV-41); race-safe writes (INV-20); transient workflow state in tracking tables, not on domain entities (INV-57).
- Agent memory writes are never silent (INV-62 capture events); access flows through `checkStreamAccess`/`computeAgentAccessSpec`, never raw `stream_members` (INV-62).
- All AI through `createAI` with telemetry (INV-28/19); models from `docs/model-reference.md` (INV-16); config in `config.ts` next to the component, shared with evals (INV-44/45); no language-specific heuristics for semantic decisions (INV-54).
- New timeline rows that every member sees go in `TIMELINE_BROADCAST_EVENT_TYPES` (`packages/types/src/constants.ts:139`) and consume a dense `broadcastSequence` (INV-61).
- Success is silent (INV-63): no `toast.success` for actions the UI already reflects.

**Product invariant introduced by this roadmap (landed as INV-65 — INV-64 was taken by mentions/actor-refs while this doc was in flight):** companion sessions are minutes-bounded. Threa does not host long-horizon autonomous work; anything longer than a session becomes a scheduled follow-up (Phase 1) or a delegation to the user's local agent (Phase 5). Codified in CLAUDE.md in step 5.1.

## Adjacent systems this roadmap must respect

Two concurrent efforts share primitives with this work; steps below reference them:

- **Conversations** are AI-clustered topic projections over a stream's messages (`conversations` table; `features/conversations/boundary-extraction-service.ts`; membership moving to `conversation_message_assignments` per `docs/plans/conversation-multi-membership-and-reassignment.md`). The companion already resolves a turn's "Current Topic" via the trigger message's primary conversation (`companion/conversation-highlight.ts`) — new durable agent rows (follow-ups, delegations) should carry an optional `source_conversation_id` anchored the same way. "Settlement" is not a flag: it's the per-stream debounce in `memos/batch-worker.ts` (`StreamStateRepository.findStreamsReadyToProcess`, 5-min cap / 30-s quiet), gated on the stream's `memory_mode`.
- **The board view** (`docs/board-view-design.md`) surfaces **conversations** as posts on the sync-engine rails. The roadmap's new cards (follow-ups 1.3, delegations 5.2, ambient 8.2) are deliberately **timeline-event-shaped, not board posts** — do not invent a second board data plane. Structural lenses (Active / Needs-resolution / Decisions) **shipped 2026-07-05 (#1178)**, and #1179 (in flight) renders agent traces, reminders, and memo captures on board surfaces via a **shared stream-row spec** — delegation and ambient cards should join that row spec when they land, anchored by `source_conversation_id`, rather than build a bespoke bump-bridge. Status-writer caution: the staleness sweep (#1187) now writes `conversation.status='stalled'` at 24h idle — any additional status writer (see 8.2) must coordinate with it.
- **Limits config** has one idiomatic layering: code default in the feature's `config.ts` → per-workspace override in `workspace_setting_overrides` (sparse key/value over `DEFAULT_WORKSPACE_SETTINGS`, `packages/types/src/workspace-settings.ts` + `features/workspace-settings/service.ts`) → per-stream column on `streams` only when product demands it, resolved `stream ?? workspace ?? default`. Feature flags are for rollout, never for numeric limits.

## Status

| Step | Deliverable                                           | Status | PR    |
| ---- | ----------------------------------------------------- | ------ | ----- |
| 1.1  | `schedule_follow_up` tool + follow-up infra           | ☑      | #1138 |
| 1.2  | Follow-up turn invocation (context + prompt)          | ☑      | #1142 |
| 1.3  | Follow-up visibility: timeline card + cancel          | ☑      | #1176 |
| 1.4  | Configurable follow-up limits (workspace setting)     | ☑      | #1223 |
| 1.5  | Turn-purpose consolidation (invocation variants)      | ☑      | #1155 |
| 1.6  | Follow-up admin tools (list/cancel/update)            | ☑      | #1159 |
| 2.1  | Generalized session abort                             | ☑      | #1177 |
| 2.2  | Stop/Redirect affordances on the activity card        | ☑      | #1190 |
| 2.3  | Per-turn model resolution + first escalation rule     | ☑      | #1202 |
| 3.1  | Persisted episode summaries                           | ☑      | #1162 |
| 3.2  | Per-thread session concurrency                        | ☑      | #1167 |
| 3.3  | Conversation-anchored agent replies                   | ☑      | #1170 |
| 4.1  | `stream_briefs` storage + endpoints + injection       | ☑      | #1214 |
| 4.2  | `update_stream_brief` tool + timeline event           | ☑      | #1220 |
| 4.3  | Brief UI: settings editor (+ timeline renderer → 4.2) | ☑      | #1218 |
| 4.4  | Brief correction eval                                 | ☐      |       |
| 5.1  | `delegate_task` tool + delegation substrate + INV-64  | ☐      |       |
| 5.2  | Delegation card UI                                    | ☐      |       |
| 5.3  | Delegation public API (claim/status/complete)         | ☐      |       |
| 5.4  | claude-code-remote delegation support                 | ☐      |       |
| 5.5  | `@threa/mcp` server                                   | ☐      |       |
| 6.1  | Memo edit/archive endpoints + explorer UI             | ☑      | #1246 |
| 6.2  | `save_memo` tool                                      | ☐      |       |
| 6.3  | Reflective capture at session completion              | ☐      |       |
| 6.4  | `memoScope` (user/stream/workspace)                   | ☐      |       |
| 6.5  | Retrieval feedback decay                              | ☐      |       |
| 7.1  | Workspace persona CRUD API                            | ☐      |       |
| 7.2  | Persona picker UI                                     | ☐      |       |
| 8.1  | Ambient classifier on settled conversations           | ☐      |       |
| 8.2  | "Ariadne noticed" card + budget + toggle              | ☐      |       |
| 8.3  | Ambient precision eval                                | ☐      |       |

Suggested order: Phase 1 → 2 → 4 → 5, with 3/6/7 interleavable anytime and 8 strictly last (it depends on 1, 1.5, and 4). Pull **3.1 forward to right after Phase 1** — fired follow-up turns consume episode summaries (see 3.1), and until it lands the 1.2 prompt hint is compensating for their absence.

---

## Phase 1 — Scheduled follow-ups (the pathfinder durable-write tool)

The cheapest team-member behavior ("I'll check back tomorrow") and the pathfinder for every later durable-write tool: it exercises the full add-a-tool checklist plus a new invocation path. (Ariadne already has ephemeral in-product writes — `send_message`, `react_to_message` — but no tool that creates durable state; that's the new territory, so give the write path its own review of access gating and abuse limits rather than assuming the react template covers it.) **Design decision:** follow-ups are NOT scheduled messages. `scheduled_messages` is user-authored by construction (`ScheduleParams.userId`, `features/scheduled-messages/service.ts:26`) and fires by creating a real USER message (`finalizeSendInTx` → `EventService.createMessage` with `AuthorTypes.USER`, `service.ts:518`); a persona must never author as the user, and a synthetic user message would pollute the timeline. Instead: a dedicated tracking table (INV-57) whose firing enqueues a `PERSONA_AGENT` job directly — the queue's `processAfter` is the reusable primitive, not the scheduled-messages table.

### 1.1 `schedule_follow_up` tool + follow-up infra

**Goal:** Ariadne can create follow-ups from a turn — the tool and its entire substrate (table, service, firing worker) in one logical unit. After this PR, "remind me to revisit this tomorrow" produces a durable, cancellable row that fires a `PERSONA_AGENT` job at the scheduled time (the turn it fires is 1.2).

**Shape:**

- Migration (`/add-migration`): `agent_follow_ups` — `id` (`agfu_` ULID), `workspace_id`, `stream_id`, `persona_id`, `session_id` (creating session), `source_conversation_id` (nullable — the trigger message's primary conversation via the `conversation-highlight.ts` resolver; anchors the follow-up to a topic for later board-lens visibility), `note` (TEXT — what Ariadne intends to do), `scheduled_for`, `status` TEXT (`pending|fired|cancelled|failed`), `queue_message_id`, timestamps. Partial index on `(stream_id) WHERE status = 'pending'` for the cap check.
- New files in `features/agents/`: `follow-up-{repository,service,worker}.ts`. Mirror the scheduled-messages worker pattern: enqueue with `processAfter = scheduledFor`; on fire, CAS `pending → fired` (INV-20 — the worker and a concurrent cancel must not race), then enqueue a `PERSONA_AGENT` job. Cancel path: CAS `pending → cancelled`; the fired job re-checks status and no-ops if cancelled (queue delivery can't be revoked). **Deviation (shipped):** the `PERSONA_AGENT` enqueue happens inside the same transaction as the CAS via `enqueueQueuedJob` (INV-7 atomicity) rather than a post-commit `jobQueue.send`, and the persona identity is carried as an additive optional `followUpId` field on `PersonaAgentJobData` (not a `trigger: { kind }` union — the union would touch every existing `trigger === MENTION` reader). Until 1.2 reads `followUpId`, a fired follow-up runs as a companion-mode catch-up turn (synthetic `messageId`, the already-supported path from `checkForUnseenMessages`). The pending cap is made exact with a per-(workspace, stream) `pg_advisory_xact_lock` around the count-guarded insert (multiple personas can run sessions in one stream, so the guard alone could race). A DLQ hook marks a follow-up `failed` if its fire job exhausts retries.
- Pending cap enforced in service with insert-or-skip discipline (like `insertRunningOrSkip`). This step reads only the code default — `DEFAULT_MAX_PENDING_FOLLOW_UPS = 10` in `agents/config.ts` — but resolves it through a small `resolveFollowUpLimit()` seam so 1.4's workspace/stream overrides slot in without touching the check.
- Tool per the `react_to_message` template end-to-end: `packages/types/src/constants.ts:384` add to `AGENT_TOOL_NAMES` + `AgentToolNames`; `tool-privacy.ts:45` categorize (`["messaging"]` — the `satisfies` clause won't compile until you do); `features/agents/tools/schedule-follow-up-tool.ts` (`defineAgentTool`, Zod input `{ note, scheduledFor }`, future-dated, ≤30 days out); deps in `tools/tool-deps.ts`; barrel export; wire in `companion/tool-set.ts` behind `isToolEnabled`; add to Ariadne's `enabledTools` in `built-in-agents.ts`.
- `promptBlock` (the field on `AgentToolConfig`, `packages/agent-runtime/src/runtime/agent-tool.ts:49`): when to use it, that a pending cap exists (tool result carries the resolved limit + current count so the model self-regulates), and that the user sees and can cancel every follow-up.

**Files:** new migration; `features/agents/follow-up-{repository,service,worker}.ts`; `agents/config.ts`; worker registration alongside `persona-agent-worker.ts`; `packages/types/src/{constants,tool-privacy}.ts` (+ privacy test); new tool file + test; `tool-deps.ts`; `tools/index.ts`; `companion/tool-set.ts`; `built-in-agents.ts`.

**Tests:** repository CAS races (two concurrent fires; fire-vs-cancel); service cap; worker no-ops on cancelled row; tool test (creates row, respects cap, rejects past dates); `tool-privacy.test.ts` update.

**Done when:** in a companion stream, "remind me to revisit this tomorrow" produces a pending `agent_follow_ups` row that fires a `PERSONA_AGENT` job at `scheduled_for` (stubbed queue in tests; manual `/verify`), and cancel wins races cleanly.

### 1.2 Follow-up turn invocation

**Goal:** the fired job runs a real companion turn that knows _why_ it woke up.

**Shape:**

- `persona-agent.ts` job handling gains the `follow_up` trigger variant: no trigger message; context assembly (`companion/context.ts` `buildAgentContext`) anchors on the stream's recent history + the follow-up `note` + a pointer to the originating session/messages.
- New system-prompt section in `companion/prompt/system-prompt.ts` ("Scheduled follow-up" — you scheduled this on <date> to: <note>; if it's no longer relevant, say nothing) — wire `keep_response`-style silent completion: a follow-up turn may legitimately conclude "nothing to add" and must not post filler.
- Session row: `trigger_message_id` nullable for this variant (check `agent_sessions` constraints; migration if needed), `withCompanionSession` resume semantics keyed on `followUpId` instead.
- One-agent-per-stream serialization applies unchanged; if a session is running when the follow-up fires, requeue with short delay (mirror `CompanionHandler`'s skip logic).

**Files:** `persona-agent.ts`, `companion/context.ts`, `companion/prompt/system-prompt.ts`, `companion/session.ts`, possibly a migration for nullable trigger.

**Deviations (shipped):**

- No `follow_up` trigger enum. The variant is signalled by the additive `followUpId` on the job/`PersonaAgentInput` (same decision as 1.1 — a `trigger` union would touch every `trigger === MENTION` reader). The agent loads the row through a `loadFollowUp` seam (`AgentFollowUpService.getById` → `AgentFollowUpRepository.findById`), bound in `server.ts` like `scheduleFollowUp`.
- No migration. The synthetic `followup_<id>` `messageId` already serves as `trigger_message_id` (a non-null synthetic string), so `withCompanionSession`'s `findByTriggerMessage` dedup is keyed on it unchanged — nullable trigger wasn't needed.
- Silent completion reuses the supersede machinery: the follow-up turn sets `allowNoMessageOutput` so `keep_response` is exposed and a "nothing to add" turn returns gracefully instead of the runtime auto-committing filler. The prompt section instructs `send_message` for the check-in or `keep_response` to stay silent.
- The prompt section ("## Scheduled follow-up firing now") is the fix for the two live staging bugs: it states the turn IS the reminder firing (kills the "I'll ping you then" decline) and forbids re-scheduling the same note (kills the every-cycle re-schedule loop), while still allowing a follow-up for genuinely new future work.

**Tests:** `buildSystemPrompt` follow-up section (present with note + local time + both bug guards; absent otherwise); `AgentFollowUpService.getById` / `AgentFollowUpRepository.findById`; worker threads `followUpId` into `agent.run`. (Full fired-job → live turn is exercised on staging — the DB+queue+AI stack the two bugs were observed in.)

**Done when:** a fired follow-up posts a contextual message referencing the original conversation — or completes silently — with a normal trace.

### 1.3 Follow-up visibility: timeline card + cancel

**Goal:** follow-ups are never invisible state (the Tag lesson: visible agent work is the trust surface).

**Shape:**

- New broadcast event `agent:follow_up_scheduled` (and `…:cancelled`): add to `EVENT_TYPES` + `TIMELINE_BROADCAST_EVENT_TYPES` (`constants.ts:113,139`), payload type in `domain.ts`, appended via `StreamEventRepository` in the same transaction as the row insert (INV-4/7), renderer `components/timeline/follow-up-event.tsx` dispatched from `event-list.tsx` (template: `memo-captured-event.tsx`).
- Card shows note + when + a Cancel action (button, not link — INV-40) for stream members; cancel goes through the service CAS. No `toast.success` on cancel — the card state change is the confirmation (INV-63).

**Files:** `packages/types/src/{constants,domain}.ts`, backend event append in `follow-up-service.ts`, new timeline component + test, `event-list.tsx`.

**Tests:** frontend component test (renders, cancel calls API, card reflects cancelled); backend test asserting event presence in the insert transaction (INV-23: presence, not counts).

**Done when:** scheduling and cancelling are both visible in-timeline for every member; contiguity (INV-61) covered by the broadcast slot.

**Deviations (shipped):**

- Payload types live in `packages/types/src/api.ts` (`AgentFollowUpScheduledEventPayload` / `AgentFollowUpCancelledEventPayload`), not `domain.ts` — that's where the sibling `MemosCapturedEventPayload` / `DescriptionSetEventPayload` capture payloads already sit. Renderer is dispatched from `event-item.tsx`'s `switch` (where `memos:captured` / `description_set` dispatch), not `event-list.tsx`.
- **Scheduling is a visible row; cancellation is a patch on it** (settled in self-review — see below). Only `agent:follow_up_scheduled` is in `TIMELINE_BROADCAST_EVENT_TYPES`; `agent:follow_up_cancelled` is an `EVENT_TYPE` that is delivered + persisted but renders zero-height. It flips the matching scheduled card to "Cancelled" via `collectCancelledFollowUpIds` (a `Set<string>` collected from the loaded window, threaded through `TimelineItemRenderContext` in both the virtualized `stream-content` path and the non-virtualized `EventList`, compared per-id in `timelineRowPropsEqual` so only the affected card repaints). The card reads `cancelledByEvent` for the authoritative, every-viewer, survives-reload state; local `useState` only optimistically fast-paths the clicking member. This matches INV-61's model exactly — a patch (like an edit/reaction) takes no broadcast slot — and avoids a redundant second row for the same cancellation.
- Full live-delivery wiring the Files list implied but didn't enumerate: two outbox event types `stream:agent_follow_up_{scheduled,cancelled}` (+ `StreamScoped` payloads, `STREAM_SCOPED_EVENTS` registration) route via the generic `isStreamScopedEvent` path (no bespoke dispatcher entry, like memos/description); frontend `stream-sync.ts` subscribes both to `handleAppendEvent`.
- A **new first-party HTTP endpoint** backs the card's Cancel button (the Files list omitted it — there was no follow-up HTTP surface): `POST /api/workspaces/:workspaceId/agent-follow-ups/:id/cancel` (`features/agents/follow-up-handlers.ts`, `routes.ts`), access-gated via `checkStreamAccess` (any member who can see the stream can cancel; 404 hides existence from non-members), plus `apps/frontend/src/api/agent-follow-ups.ts`. `AgentFollowUpService.cancel` gained an optional `cancelledBy` so the cancelled row attributes to the user (card) or the persona (`cancel_follow_up` tool). The append lives in the service (`schedule` / `cancel` transactions), so the persona's own tool paths emit the rows too — one append site, INV-35.

### 1.4 Configurable follow-up limits (administrative)

**Goal:** the pending cap becomes workspace-tunable (and per-stream when someone actually asks), instead of a hardcoded global.

**Shape:** the idiomatic limits layering (see Adjacent systems): keep `DEFAULT_MAX_PENDING_FOLLOW_UPS` in `agents/config.ts` as the code default; add `maxPendingFollowUps` to `WorkspaceSettings` + `DEFAULT_WORKSPACE_SETTINGS` (`packages/types/src/workspace-settings.ts`) and the `flattenUpdates` allowlist in `features/workspace-settings/service.ts` — sparse override in `workspace_setting_overrides`, broadcast on change. `resolveFollowUpLimit()` from 1.1 resolves `workspace setting ?? code default`. Surface the field in the existing workspace settings UI. A per-stream column on `streams` (resolved `stream ?? workspace ?? default`) is deliberately deferred until a real need shows up (INV-36) — the resolver seam makes it a small follow-up.

**Files:** `packages/types/src/workspace-settings.ts`, `features/workspace-settings/service.ts` (+ test), `agents/follow-up-service.ts` resolver, workspace settings UI section.

**Tests:** resolution precedence (override set vs absent); settings round-trip incl. reset-to-default deletes the override row.

**Done when:** a workspace admin can raise the follow-up cap from settings and the tool's self-reported limit reflects it.

**Deviations (shipped):**

- **The default value lives in `@threa/types`, not `agents/config.ts`.** `DEFAULT_MAX_PENDING_FOLLOW_UPS` moved to `packages/types/src/workspace-settings.ts` (the source `DEFAULT_WORKSPACE_SETTINGS.maxPendingFollowUps` seeds from) and `agents/config.ts` re-exports it, so the code default and the setting default are one number, not two that drift (INV-33) — same pattern as `STREAM_BRIEF_MAX_CHARS` in 4.3. The follow-up service no longer imports the constant: `resolveFollowUpLimit()` reads the already-merged value from `WorkspaceSettingsService.getSettings`, so the re-export just keeps the code-default name available in the agents layer.
- **`resolveFollowUpLimit()` reads the setting via an injected resolver.** `AgentFollowUpService` gains a `workspaceSettingsService` dep (narrowed to `FollowUpLimitResolver = { getSettings }` so tests stub it) and resolves `(await getSettings(ws)).maxPendingFollowUps` before the insert transaction (INV-41). `getSettings` always returns a merged value, so there's no fallback branch at the call site.
- **UI lands in the General tab, not a new "Assistant" tab.** A single numeric field doesn't warrant its own tab (INV-36). `FollowUpLimitSection` (`components/workspace-settings/follow-up-limit-section.tsx`) renders under workspace identity/region: an admin-gated number input (save-on-blur, clamped to `[MAX_PENDING_FOLLOW_UPS_MIN, MAX_PENDING_FOLLOW_UPS_MAX]`, optimistic bootstrap-cache write, no success toast per INV-63), read-only value for non-admins. Bounds constants are shared from `@threa/types` by the API Zod validator and the input.
- Per-stream override still deferred (INV-36); the resolver seam keeps it a small follow-up.

### 1.5 Turn-purpose consolidation (invocation variants)

**Goal:** one first-class answer to "why is this turn running," replacing accumulating optional fields and ad-hoc flags. **Hard prerequisite for Phase 8**, which adds invocation kind #5.

**Shape:** `PersonaAgentInput` carries four orthogonal variant signals — `trigger?: MENTION`, `supersedesSessionId?`, `rerunContext?` (`persona-agent.ts:138-149`), and `followUpId?` (#1142) — each with scattered if-branches, a bespoke prompt section, and repurposed runtime flags (`allowNoMessageOutput` was supersede-only, now also follow-up; the runtime's continuation prompt still uses supersede wording on follow-up turns, recorded as out-of-scope in #1142). Consolidate into a discriminated union `purpose: { kind: 'catch_up' | 'mention' | 'follow_up' | 'supersede_rerun', … }` resolved in **one place** into three derived behaviors: (a) the purpose's system-prompt section (self-describing, mirroring the tools' `promptBlock` pattern), (b) runtime flags derived from purpose kind — never set ad hoc; this also fixes the supersede-flavored continuation-wording leak mechanically, (c) context-assembly hints for `buildAgentContext`. Wire compat: job payload fields stay as-is (queue rows in flight); the worker maps payload → purpose at the boundary. This pays down the refactor 1.2's recorded deviation deferred ("a `trigger` union would touch every `trigger === MENTION` reader") — once, before ambient turns multiply the variants.

**Files:** `persona-agent.ts` (input type + variant readers), `persona-agent-worker.ts` (payload→purpose mapping), `companion/context.ts`, `companion/prompt/system-prompt.ts` (per-purpose sections), `packages/agent-runtime` `TurnRequest` if flag derivation moves there.

**Tests:** existing per-variant tests pass unchanged (behavioral no-op); one test per purpose kind asserting derived flags + prompt-section presence.

**Deviations (shipped):**

- `TurnPurpose` union + `resolveTurnPurpose` (payload→purpose at the worker boundary) + `deriveTurnFlags` live in a new `features/agents/turn-purpose.ts`. Flag derivation stayed backend-side (`deriveTurnFlags`), not moved onto `TurnRequest` — cleaner than plumbing purpose into the generic runtime.
- Per-purpose prompt sections unified in `companion/prompt/turn-purpose-prompt.ts`: `buildEarlyPurposeSection` (mention, follow-up — before stream context) and `buildLatePurposeSection` (supersede reconciliation — last, for final-decision salience). The supersede section moved out of persona-agent's `buildSupersedeRerunSystemPrompt` wrap into `buildSystemPrompt` at its exact prior position (after temporal), so composition is byte-identical to the old wrap.
- The continuation-wording leak is fixed at the source: the runtime's `allowNoMessageOutput` continuation prompt (`agent-runtime.ts`) is now edit-neutral, since that phrasing already misapplied to fired-follow-up _and_ research turns. The supersede system-prompt section still carries the edit-comparison instructions where they belong.
- Degradation preserves behavior via `effectivePurpose`: a supersede rerun whose target session vanished, or a follow-up whose row failed to load, resolves to `catch_up` — so its prompt section and derived flags match the plain-catch-up turn it already ran as (true no-op).

**Done when:** adding a new invocation kind = one union member + its prompt block — no new optional field on `PersonaAgentInput`, no ad-hoc flag setting.

### 1.6 Follow-up admin tools (list/cancel/update)

**Goal:** Ariadne can administer the follow-ups she schedules, not just create them. Before this, `schedule_follow_up` (1.1) was the only follow-up tool — she had no way to see, cancel, or reschedule a pending follow-up across turns, so a plan change or a resolved item left a stale reminder that still fired. This also gives the 1.2 "don't re-schedule the same note" guard a mechanical backstop: she can cancel/reschedule the existing row instead of relying on a prompt-only don't-loop instruction.

**Shape:** three tools per the 1.1 checklist, all riding the always-allowed `messaging` privacy class (in-product self-administration, not egress — same as `schedule_follow_up`) and **stream-scoped by the bind** so a turn only touches its own stream's follow-ups:

- `list_follow_ups` (no input) — the stream's pending follow-ups (id, note, local time), soonest-first. The discovery tool: it's what turns a `followUpId` into something the model can act on across turns, and a dedupe check before scheduling.
- `cancel_follow_up` `{ followUpId }` — reuses 1.1's `AgentFollowUpService.cancel` CAS (`pending → cancelled` + queue tombstone), now stream-scoped via `markCancelledInStream`.
- `update_follow_up` `{ followUpId, note?, scheduledFor? }` (≥1 of note/time) — new `AgentFollowUpService.update`: reads the row, coalesces unspecified fields, CAS-updates the pending row (`updatePending`), and on a time change tombstones the old fire job and enqueues a fresh one at the new time in the same tx (INV-7), mirroring the scheduled-messages reschedule.

**Race-safety (INV-20):** rescheduling could let a surviving old queue tick fire the row early, so `markFired` now guards on `scheduled_for <= NOW()` — a no-op on the normal path (fire `processAfter` equals `scheduled_for`), but it makes a rescheduled-to-later row wait for the freshly enqueued job. `update` verifies `existing.streamId` before mutating (`stream_id` is immutable, so the read-then-CAS is safe); the `scheduledFor` future/horizon validation is shared with `schedule_follow_up` via `tools/follow-up-shared.ts` (also extracted `formatLocalTime`).

**Files:** `packages/types/src/{constants,tool-privacy}.ts`; `features/agents/follow-up-{repository,service}.ts` (+ tests); new `tools/{list-follow-ups,cancel-follow-up,update-follow-up}-tool.ts` + `tools/follow-up-shared.ts` (+ tests); `tools/{tool-deps,index}.ts`; `companion/tool-set.ts`; `persona-agent.ts` (deps + bundle); `server.ts` (bind to service); `built-in-agents.ts` (Ariadne `enabledTools`).

**Deviations (shipped):** each admin tool takes its own narrow deps interface (not the whole `FollowUpToolDeps` bundle) so its unit test wires one callback; the bundle `FollowUpToolDeps` extends all four and is what the live companion turn passes (the researcher sub-agent still never gets it). Stream scoping is dedicated plain-`sql` methods (`markCancelledInStream`, `updatePending`, `listPending`) rather than optional `streamId` params on the workspace-scoped worker/HTTP methods — `composeSql` can't splice squid `sql`+`sql.raw` fragments cleanly, and the duplication is one small CAS. Enclave/E2E parity omitted, consistent with `schedule_follow_up` (clean degrade — see the backlog parity item).

**Tests:** repository — `listPending`, `updatePending`, `markCancelledInStream` scoping, `markFired` time guard; service — `listPending`, `update` (reschedule tombstone+re-enqueue, note-only no-reschedule, not_found / other-stream / not_pending / lost-race), stream-scoped `cancel`; three tool tests (happy paths, validation, error reasons); `tool-privacy.test.ts` covers the new tools via its `satisfies` enumeration.

**Done when:** in a companion stream, Ariadne can list her pending follow-ups, cancel one that's no longer needed, and push another's time out — each stream-scoped, race-safe, and reusing the 1.1 substrate.

---

## Phase 2 — Steer & stop (runtime polish)

No new capabilities — surfacing machinery that already exists. Independent of Phase 1.

### 2.1 Generalized session abort

**Goal:** any running session can be stopped, not just research tools.

**Shape:** `sessionAbortRegistry` (`agents/session-abort-registry.ts`) already holds one AbortController per session; `persona-agent.ts:694` wires `toolSignalProvider` only for research tools. Extend: pass the signal to every tool whose execute can exceed ~2s (web_search, read_url, attachment reads, GitHub/Linear fetches — thread the signal into their HTTP calls); on abort mid-loop, the runtime finishes gracefully (partial results, `user_abort` reason — the graceful path already exists, distinguish from `shouldAbort`). Socket action `agent_session:research:abort` (handled `apps/backend/src/socket.ts:286-349`) is kept as-is on the wire for compat but the backend gating no longer requires a research step to be active. Rename internals to `session abort`; do not carry deprecated aliases (INV-49) beyond the wire name.

**Files:** `persona-agent.ts`, tool files that gain signal support, `socket.ts` gating, `hooks/use-abort-research.ts` (gating only).

**Tests:** abort mid-`web_search` returns partial gracefully; abort with no tool running cancels the pending LLM iteration.

**Done when:** Stop works on any running session regardless of which tool is active.

**Deviations (shipped):**

- **Two-layer abort, with the loop layer as the primary mechanism.** A new `runAbortSignal` on `AgentRuntimeConfig`/`TurnSink` (backed by the session's `AbortController`) is threaded into the loop's `generateTextWithTools` call and checked at the top of each iteration: a Stop cancels a pending LLM iteration and halts the loop **gracefully** — it returns whatever the turn holds (a committed reply, or none, with `noMessageReason: "Stopped by the user…"`) instead of the fatal `shouldAbort` throw. This is what makes Stop work "regardless of which tool is active": after any tool returns, the next loop-top check halts the session. `persona-agent.ts` now registers one session controller **up front** (not lazily per research tool) and hands its signal to BOTH edges — `runAbortSignal` and a `toolSignalProvider` that returns it for **every** tool (one path, INV-35), replacing the old research-only gate.
- **Tool-layer honoring is scoped to the two genuine long-poles.** `web_search` and `read_url` compose `opts.signal` with their existing 30 s fetch timeout (`composeAbortSignal`) so a Stop cuts an in-flight fetch immediately and returns a graceful `{ stopped: true }` (distinguished from a timeout). The research tools already honored the signal.
- **Both first-party drivers wired.** The sealed/enclave path (`apps/enclave/src/agent/run-turn.ts`) already had a live Stop channel — the session runner's heartbeat consumes the backend's `requestAbort` flag into an `AbortController` — but only fed it to research's `toolSignalProvider`. It now sets `runAbortSignal` + an all-tools `toolSignalProvider` too (it goes through the same `runTurnOnAgentRuntime`), so a Stop halts a sealed session mid-LLM-call or mid-`web_search`/`read_url`, not only during research (caught in self-review).
- **GitHub / Linear / attachment internal signal-threading deferred (noted, not silent).** Their clients (`Octokit`, the Linear SDK, the S3 `StorageProvider`) don't accept a per-call signal without changing those class APIs and ~15 call sites, and the loop-layer abort already halts the session promptly after those fast DB/SDK calls return — only the 30 s HTTP fetches needed internal honoring. Threading the signal into those clients is a clean follow-up if a slow-call case shows up (INV-36: not built speculatively).
- **Frontend untouched.** The `agent_session:research:abort` wire event and `use-abort-research.ts` are kept as-is (INV-49: rename internals only — comments/logs now say "session abort"); the card's Stop/Redirect relabel and "gate on running, not research" is 2.2's job, not this step.

### 2.2 Stop/Redirect affordances on the activity card

**Goal:** make "jump in and steer" legible.

**Shape:** `agent-session-event.tsx:321-337` right-slot already renders `StopResearchButton` gated by `canAbortResearch`; after 2.1, gate on "session running" instead and relabel Stop. Add **Redirect**: focuses the composer with a subtle hint ("Ariadne will fold your message into her current work") — no new backend; `NewMessageAwareness` (`agent-runtime.ts:20`) already injects mid-run messages and triggers the `reconsidering` event. Both actions are buttons (INV-40), no layout shift when they appear (INV-21 — reserve the slot).

**Files:** `agent-session-event.tsx`, `stop-research-button.tsx` (generalize), `stream-content.tsx`/`event-list.tsx` prop threading, `trace-dialog.tsx`.

**Tests:** component tests: buttons render only while running; Redirect focuses composer; Stop calls the abort hook.

**Done when:** any member of the stream can stop or redirect a running session from the card.

**Deviations (shipped):**

- **Gating collapsed onto the card's own derived status.** The per-session `sessionCanAbort` map (step-type gating via `isAbortableStepType`) is deleted end-to-end — the card shows the Redirect/Stop pair whenever its derived status is `running`, so the buttons are stable for the whole run instead of popping in and out as steps change (INV-21). `isAbortableStepType`/`ABORTABLE_STEP_TYPES` had no remaining callers and were removed (INV-38).
- **The trace dialog's in-flight step button generalizes with it.** Since 2.1 the abort halts the whole session regardless of active tool, so the per-step "Stop research" gate in `trace-step.tsx` (abortable step types only) became wrong; the Stop button now renders on any in-progress step while the session runs.
- **`StopResearchButton` → `session-action-buttons.tsx`.** One private base button; exports `StopSessionButton` ("Stop", red hover tint — the research-purple tie no longer applies) and `RedirectSessionButton` ("Redirect", primary tint). Hook renamed `useAbortResearch` → `useAbortSession` (INV-49); the wire event stays `agent_session:research:abort`.
- **Redirect is pure frontend, anchored to the surface's editor zone.** The click walks `closest("[data-editor-zone]")` and reuses `focusVisibleZoneEditor` (exported from `message-event.tsx`, the inline-edit restore path) so the right composer gets focus in both the main view and the thread panel. The hint ("{persona} will fold your message into the current work") borrows the card's single-line subtitle slot for 5 s — same line, no height change (INV-21) — rather than adding composer-side state threading.

### 2.3 Per-turn model resolution + first escalation rule

**Goal:** break the static `persona.model` assumption; ship one conservative escalation rule.

**Shape:**

- New `resolveTurnModel(persona, turnContext)` in `agents/` alongside `resolveContextWindowPolicy` (the per-turn precedent, resolved at the dispatch seam `persona-agent.ts:308`). Default: `persona.model`. Persona config gains optional `escalationModel` (Ariadne: an Opus-class id — **first add the current Opus model to `docs/model-reference.md` via `/search-model`; INV-16 blocks using an undocumented id**).
- Rule v1 (mechanical, no language heuristics per INV-54): a supersede rerun whose previous attempt failed the response validator escalates. Further rules (user "think hard" hint = model-classified; research-heavy turns) are follow-ups, not this step.
- Telemetry: resolved model id flows into the existing otel metadata (`persona-agent.ts:660`), plus a `model_escalated` trace step so escalations are visible in the trace dialog.

**Files:** `agents/turn-model.ts` (new), `built-in-agents.ts` schema + Ariadne config, `persona-agent.ts` call site, `docs/model-reference.md`.

**Tests:** resolver unit tests (default; escalation on failed-validation rerun); config schema test.

**Done when:** normal turns still run Sonnet; a failed-validation rerun demonstrably runs the escalation model (assert via stubbed AI capture).

**Deviations (shipped):**

- **The "previous attempt failed the validator" signal needed a substrate the Shape didn't enumerate.** The runtime's validation-failure terminal (kept-response after `MAX_REPEATED_INVALID_DRAFTS`) now returns a structured `responseValidationFailed` on `AgentRuntimeResult` — deliberate `keep_response` keeps and user Stops are excluded, and a salvage commit that passes late validation clears it. Dispatch persists it to a new `agent_sessions.response_validation_failed` column (`markResponseValidationFailed`, the `episode_summary` precedent: post-completion metadata of the session row, not workflow state). `resolveTurnModel` reads it off the superseded session already loaded by `loadSupersededMessagePlan` — no extra query.
- **`escalationModel` is built-in-config only** (`builtInAgentConfigSchema`, patchable via `agent_config_overrides`; Ariadne: `openrouter:anthropic/claude-opus-4.8`). DB personas resolve `escalationModel: null` — escalation disabled, no `personas` column until workspace personas need it (INV-36); `resolveTurnModel` is the single consumer so the column slots in without touching call sites.
- **`model_escalated` is a first-class `AgentStepType`** (constants + frontend `STEP_DISPLAY_CONFIG`, which is exhaustive-typed). Dispatch emits it via `trace.startStep` before the loop with `{fromModel, toModel, cause}` provenance. An `escalationModel` equal to `persona.model` reports `escalated: false` — no no-op step.
- **The resolved model drives everything the model id touched:** `getLanguageModel`/`parseModel`/`modelString`, otel + telemetry metadata (plus a `model_escalated` flag), and `supportsVision` — so the toolset's vision support matches the model actually running. `models.yaml` gained `claude-opus-4.8` (text+image); without it the registry would silently strip vision on escalated turns.
- **E2E/enclave untouched:** the message-mutation handler never dispatches reruns for E2E streams, so escalation cannot apply there.

---

## Phase 3 — Session continuity

Independent; interleave anytime.

### 3.1 Persisted episode summaries

**Goal:** "as we discussed last week" works after the context window scrolls past.

**Shape:** at session completion (third phase of `withCompanionSession`, `companion/session.ts`), enqueue a summary job (do NOT summarize inline — INV-41 keeps the completion txn short): haiku-4.5 condenses the session (trigger, what was researched, what was concluded) into ~2-3 sentences stored on `agent_sessions.episode_summary` (migration: nullable TEXT column — post-completion metadata of the session row itself, not workflow state, so a column not a tracking table). Read path: `buildAgentContext` includes the last N episode summaries for the stream (N from `companion/config.ts`) in a "Previous sessions" prompt section when they aren't already covered by the rolling summary; `workspace_research` can also query them (extend the researcher's stream-context source, not a new tool).

Not a duplicate of the two existing summaries: `conversations.topic_summary` names a clustered topic, and the rolling `agent_conversation_summaries` fold is per-(stream, persona) context-window management — neither captures "what Ariadne did and concluded in a session," which can span multiple conversations. Reuse the `conversation-summary-service.ts` worker pattern rather than adding a parallel summarizer.

**Feeds fired follow-up turns directly** (why this step should be pulled forward to right after Phase 1): `agent_follow_ups.session_id` records the creating session, so the fired turn (1.2) loads that session's episode summary — the _context of the promise_, not just its note text. Until this lands, 1.2's "this IS that reminder firing" prompt hint is compensating for missing episodic memory; after it, the hint carries purpose and the summary carries the substance.

**Files:** migration, `companion/session.ts` (enqueue), fold into the existing summary worker (`conversation-summary-service.ts` precedent), `companion/context.ts`, `companion/prompt/system-prompt.ts`, `companion/config.ts` (model + N).

**Tests:** summary written post-completion (stubbed AI); context assembly includes summaries; INV-19 telemetry on the summarizer call.

**Deviations (shipped):**

- **Enqueue lives in the persona-agent worker, not literally inside `withCompanionSession` Phase 3.** After a turn completes, `persona-agent-worker.ts` enqueues `AGENT_EPISODE_SUMMARIZE {workspaceId, sessionId}` — the same post-completion spot as the existing `checkForUnseenMessages` nudge, so both post-completion dispatches sit together. Best-effort (a lost enqueue just drops one session from later context); INV-41 is satisfied identically (no summarizer AI runs inline). Gated on `messagesSent > 0`: a silent/no-op turn has nothing to condense, and research-without-reply capture is 6.3's job, not this one.
- **New `episode-summary-{service,worker}.ts` rather than folding into `conversation-summary-service.ts`.** The rolling summarizer folds _dropped messages_ via `foldRollingSummary` (a rolling batch fold); an episode summary is a one-shot condensation of a _whole session_ (trigger + turn-digest findings + reply). It reuses the _pattern_ (cheap haiku, low temperature, INV-19 telemetry, service+worker split) but not the fold, which doesn't fit. Column stored via `setEpisodeSummary` CAS on `IS NULL`, so a redelivered job or concurrent summarizer is safe (INV-20).
- **Episode summaries are scoped per (stream, persona), like the turn-digest read** (`findRecentDigestStepsByStream`), not stream-wide — a persona loads only its own episodes, never another persona's. The fired-follow-up case (§1.2) is covered by construction: the creating session is in the same stream, so its summary rides the stream read; no separate `followUpId → session_id → summary` lookup was needed. `EPISODE_SUMMARY_INJECT_COUNT = 3`.
- **"Not already covered by the rolling summary" ships as a distinct section, not overlap-detection.** The rolling summary carries dropped-message content; the "Previous sessions" block carries session conclusions — different framing, low redundancy — so precise dedup is deferred (INV-36).
- **`workspace_research` querying episode summaries is deferred** (tracked below). The researcher is a search loop with no single stream-context preamble to extend cleanly, and the "Done when" is fully met by the `buildAgentContext` read path. A focused follow-up.

**Done when:** a fresh session in a stream with prior sessions carries their episode summaries in its context.

### 3.2 Per-thread session concurrency

**Goal:** a busy channel and its threads don't serialize on one agent slot — _if they currently do_.

**Shape:** first verify: sessions key on the _addressed_ stream id (`agent_sessions.stream_id` + partial unique index `WHERE status='running'`). Threads are their own stream ids, so channel+thread may already run concurrently — in that case this step reduces to adding the missing test and closing. If serialization on the root exists anywhere (e.g. `CompanionHandler` root-resolution reusing the root id for the session), scope the session to the addressed stream and keep companion-mode resolution through the root (threads inherit, `companion-outbox-handler.ts:87`).

**Files:** investigation first; then possibly `companion-outbox-handler.ts`, `companion/session.ts`, test either way.

**Tests:** concurrent sessions in a channel and its thread both run; two messages in the _same_ thread still serialize (INV-20 index).

**Done when:** the concurrency semantics are tested, whichever way the investigation lands.

**Investigation outcome (shipped): already concurrent — test-only, no code change.** Sessions key on the _addressed_ stream id end to end, so channel + thread never share a slot:

- The running-session slot is the partial unique index `agent_sessions(stream_id) WHERE status='running'` (`20260109155152_agent_session_one_running.sql`). Threads are their own stream ids.
- Dispatch keys on the addressed stream: `CompanionHandler` sends the `PERSONA_AGENT` job with the message's own `streamId` — root resolution (`companionSource`) is used only to inherit companion mode + persona, never to re-key the dispatch (`companion-outbox-handler.ts:86-158`).
- Session insert keys on the addressed stream: `persona-agent.ts` sets `sessionStreamId = streamId` (a channel _mention_ spawns a fresh thread and keys on _that_), and `withCompanionSession` passes it verbatim to `insertRunningOrSkip` (`companion/session.ts:87`). The only root usages in the turn — tool-privacy policy and context-window policy (`persona-agent.ts:288`) — don't touch session keying. The other two `insertRunningOrSkip` callers (public-api bot invocations, enclave claim) likewise key on the invocation's target stream.
- No advisory lock or other primitive serializes sessions on the root (the `pg_advisory_xact_lock` in `agents/` is the follow-up cap, unrelated).

So a channel/scratchpad and a thread beneath it already run concurrently, and two turns in the same thread serialize on the index. The missing coverage — the concurrency contract as a unit — landed in `companion/session.test.ts` (`per-stream session concurrency (roadmap 3.2)`): distinct addressed streams both complete with their own `stream_id` forwarded to `insertRunningOrSkip`; a same-stream second turn whose insert conflicts (null) skips as "agent already running for stream" with no started event. The existing `companion-outbox-handler.test.ts` already covers threads dispatching on their own id.

### 3.3 Conversation-anchored agent replies

**Goal:** Ariadne's reply lands in the conversation she's actually participating in — declared at send time, not inferred.

**Shape:** today agent replies skip the LLM extractor (good) but join the stream's **most-recently-active** conversation (`assignAgentReply`, `boundary-extraction-service.ts:595-618` — `findActiveByStream(...)[0]`). In a busy channel with interleaved topics, a reply triggered by a message in conversation X gets filed into whichever conversation Y was touched last. The fix mirrors the board composer's declared path: a message carrying `conversationIntent` is assigned synchronously in the send transaction and the extractor short-circuits (`boundary-extraction-service.ts:74`; `CreateMessageParams.conversationIntent`, `messaging/repository.ts:80`; the conversation-assigner is already injected into `EventService`). The companion already resolves the trigger's primary conversation for its "Current Topic" highlight (`companion/conversation-highlight.ts`) — thread that same anchor through `doSendMessage` (`persona-agent.ts:423`) so the persona write declares its conversation explicitly; fall back to today's most-recently-active behavior when no anchor resolves (highlight is best-effort — segmenter lag, E2E). Resolve in-step whether the wire is `conversationIntent: 'existing'` + assigner resolution or a direct conversation-id param on the persona write path — whichever the assigner seam supports without a parallel path (INV-35).

**Files:** `persona-agent.ts` (`doSendMessage` + anchor threading from context assembly), possibly `conversation-assigner.ts`/`messaging` param plumbing, tests.

**Tests:** the interleaved-topics case — two active conversations in one channel, trigger in the older one, reply lands in the trigger's conversation; fallback when no primary resolves; board card shows the reply under the right post.

**Done when:** in a channel with two live topics, Ariadne's reply is assigned to the trigger's conversation, synchronously, without the extractor.

**Deviations (shipped):**

- **Wire shape: the existing `conversation` directive, not a new param (INV-35).** `doSendMessage` (`persona-agent.ts`) passes `conversation: { intent: 'existing', conversationId }` into `createMessage` → `EventService.createMessage`, whose injected `conversationAssigner` attaches the reply in the send transaction and stamps `conversation_intent` on the row. Boundary extraction then short-circuits on `message.conversationIntent !== null` (`declaredSkip`, `boundary-extraction-service.ts:74`) — it never reaches `assignAgentReply`'s most-recently-active fallback. No anchor resolves → the directive is omitted → today's `assignAgentReply` behavior. No new send path, no direct conversation-id param.
- **Anchor reuses `resolveEligibleConversation` (INV-35).** The reply's declared conversation is the trigger's own topic via a memoized `resolveTriggerConversationId` in the turn: prefer the trigger's PRIMARY conversation, else the most recently active over the context window. The follow-up `source_conversation_id` resolution (§1.1) now shares this exact memoized closure — a reply and any follow-up it schedules anchor to the same topic, and the resolver runs at most once per turn.
- **Cross-root safety is structural, not a catch.** The anchor is always the trigger's own conversation, which shares the reply's access root by construction (trigger + reply sit in the same stream, or a channel and a thread beneath it), so the assigner's `CONVERSATION_NOT_IN_ROOT` guard never fires on this path — no send-failing 400 to defend against.
- **Not on the supersede EDIT path.** A supersede rerun edits an existing message; an edit keeps the conversation the original send already declared, so the directive is only set on the `createMessage` (new-message) branch.
- **Test coverage: the anchor resolver, previously untested.** `resolveEligibleConversation` embodies the whole 3.3 contract (prefer the trigger's conversation over most-recently-active) and had no test; `companion/conversation-highlight.test.ts` now covers the interleaved-topics case (trigger classified into the older topic → resolver returns it, not the last-active one), the extraction-lag fallback, eligibility skipping, and the null cases. Fake-`Querier` + scoped `spyOn` (INV-48), consistent with the assigner and per-stream-concurrency tests. The declared→attach path itself is already covered by `conversation-assigner.test.ts` (existing same-root guard).

---

## Phase 4 — Durable stream brief (big rock 1)

Tag's channel memory / Claude Code's CLAUDE.md: a persistent, human-auditable, correctable working document per stream. Unlike the rolling summary (ephemeral, rebuilt per turn), the brief is durable, versioned, and user-editable. This most directly attacks re-explaining context.

### 4.1 `stream_briefs` storage + endpoints + prompt injection

**Goal:** the brief exists and already shapes every companion turn — the first PR changes observable behavior, not just schema. Human-editable via API; agent writes come in 4.2, UI in 4.3.

**Shape:**

- Migration: `stream_briefs` — `id` (`sbrf_`), `workspace_id`, `stream_id` (unique per stream), `content` TEXT (markdown; hard cap ~4,000 chars enforced in service — it's a prompt insert, not a document store), `version` INT, `updated_by_kind` TEXT (`user|persona`), `updated_by_id`, timestamps. Revisions table `stream_brief_revisions` (`sbrv_`): brief id, version, content, author, created_at — the audit trail Tag's "admins can audit/edit/delete memory" converged on.
- Repo + service in `features/streams/` (the brief is a property of the stream surface, not the agent) with optimistic-concurrency update (`WHERE version = $expected` — INV-20; reject on mismatch with 409).
- Endpoints: `GET/PUT /api/workspaces/:wid/streams/:sid/brief` (Zod-validated, INV-55), access via `checkStreamAccess`; PUT requires membership.
- Injection: `buildSystemPrompt` (`companion/prompt/system-prompt.ts:19`) gains a "Stream brief" section early in the layered order (stable content — good for prompt caching; keep temporal context last as today). Threads inherit the root stream's brief (same rule as companion mode).

**Files:** migration, `features/streams/brief-{repository,service}.ts` (or fold into stream service if small — follow INV-27 composability), `routes.ts`, handler, `companion/context.ts`, `companion/prompt/system-prompt.ts`.

**Tests:** version-conflict rejection; access gating (non-member 403; thread inherits root access per INV-62); size cap; prompt assembly includes the brief; thread turn carries the root's brief.

**Done when:** a brief PUT via API observably changes the next companion turn's behavior in that stream.

**Deviations (shipped):**

- **The brief keys on the effective root for writes too, not just reads.** GET and PUT on a thread both resolve `rootStreamId ?? id` (`resolveBriefStreamId`, exported from the streams barrel) before touching the row, so a thread PUT edits the root's brief rather than 404ing or forking a thread-local one — "threads inherit" with a single row per root. PUT membership is likewise checked against the effective root.
- **Access-denial codes follow the codebase convention, not the step's test list:** a caller who can't see the stream gets 404 (`STREAM_NOT_FOUND`, hiding existence — same as the follow-up cancel endpoint), not 403; 403 (`BRIEF_MEMBERSHIP_REQUIRED`) is reserved for the reader-but-not-member PUT on a public stream.
- **Wire shape:** PUT body is `{ content, version }` where `version` is what the client read (`0` = creating); the 409 carries the fresh row in `details.current` so the client (and the 4.2 tool) can merge and retry. Create-vs-create races collapse into the same conflict outcome via `INSERT … ON CONFLICT (stream_id) DO NOTHING` (INV-20 single-statement, no advisory lock needed).
- **E2E streams have no briefs in v1.** `buildEnclaveSystemPrompt` is untouched AND the PUT rejects `e2eEnabled` streams (400 `BRIEF_E2E_UNSUPPORTED`) — a sealed stream's brief would be server-stored plaintext the enclave prompt never injects, i.e. a silent no-op attached to an encrypted surface (caught in pre-PR review). Consistent with E2E parity being deferred across this roadmap (follow-ups, delegations); revisit with the sealed wire. The brief content column is markdown TEXT only (no `content_json` twin) — fine for a prompt insert consumed verbatim, but if the 4.3 editor goes rich-text it will want a `content_json` column like stream descriptions have (append-only migration, cheap).

### 4.2 `update_stream_brief` tool + timeline event

**Goal:** Ariadne maintains the brief, visibly.

**Shape:**

- Tool per the 1.1 checklist: `update_stream_brief` takes `{ content, reason }` (full replacement — patches invite merge bugs; the 4k cap keeps replacement cheap), writes through the 4.1 service with the version the turn read at context time (a concurrent human edit → 409 → tool returns the conflict and the fresh brief so the model can retry once).
- Broadcast event `stream:brief_updated` (constants + payload + append in the same txn as the write): who, version, `reason`, and a short diff summary — brief changes are never silent (INV-62 spirit).
- promptBlock: maintain the brief when durable facts change (decisions, goals, preferences); never store secrets; prefer editing over appending.

**Files:** types constants/domain, tool file + deps + barrel + `tool-set.ts` + `built-in-agents.ts`, `brief-service.ts` event append.

**Tests:** tool happy path + version-conflict retry; event presence in txn.

**Done when:** "actually, we decided X" leads to a brief update visible as a timeline row, and the next turn's prompt carries the new content.

**Deviations (shipped):**

- **One append site — the event fires for member edits AND persona writes.** The `brief_updated` timeline row is appended inside `StreamBriefService.update` (the 4.1 write path both the settings PUT and the tool go through), not only on the tool path — so a member correcting the brief in settings is just as visible as a persona write (INV-35 one append site, INV-7 same-txn atomicity, "never silent" for members too). This is where 4.3's deferred author attribution lands: the row carries `actorId`/`actorType` for user edits as well. `UpdateBriefParams` gained an optional `reason` (the persona tool supplies it; member edits leave it `null`).
- **Event/wire split follows the `description_set` precedent.** `EventType` is `brief_updated` (added to `TIMELINE_BROADCAST_EVENT_TYPES` and to `STREAM_ROW_SPEC` as `CHROME_BROADCAST` — a broadcast timeline row, never a board/topic row, so it consumes a dense broadcast slot per INV-61); the outbox/wire type is `stream:brief_updated`, routed via the generic `isStreamScopedEvent` path (`STREAM_SCOPED_EVENTS`, no bespoke dispatcher entry), and the frontend `stream-sync.ts` subscribes it to `handleAppendEvent` like the memos/description/follow-up rows.
- **Payload is `{ briefId, version, reason }` — no content/diff snapshot.** The row names who (event actor), the resulting `version` (`=== 1` renders "created" vs "updated"), and the persona's `reason`. The "short diff summary" (before/after) is **deferred with the revision-history browser** (needs the `stream_brief_revisions` list endpoint 4.3 also deferred, INV-36); the current text is one fetch away via the brief endpoint and the row deep-links to it, so no 4k-char content is snapshotted onto every event.
- **Optimistic concurrency: the tool tracks a per-turn `knownVersion`.** It's seeded from the brief version read at context time (exposed on `AgentContext.streamBrief`, threaded to `buildToolSet` as `briefVersion`), advanced after each write and on conflict. A concurrent member edit yields a `version_conflict` carrying the current content + fresh version; the tool surfaces that to the model (with the fresh version already armed) so its retry re-applies on top instead of clobbering an edit it never saw. "Retry once" = the model re-calling `update_stream_brief` after the conflict result.
- **Deep-link opens the Companion tab** (where 4.3's `BriefSection` lives) via `openStreamSettings(streamId, "companion")` — a settings-overlay action, so a button not a link (INV-40). No per-section anchor exists yet; the brief sits at the bottom of that tab.
- **Wired plaintext-only.** `server.ts` binds `updateBrief` to `StreamBriefService`; the tool rides the always-allowed `messaging` privacy class (in-product self-administration, bounded by the 4k cap + stream membership, not a privacy grant). Enclave/E2E parity omitted, consistent with `schedule_follow_up` — the enclave turn path never binds `updateBrief`, so the tool is simply absent there.

### 4.3 Brief UI: settings editor + timeline event renderer

**Goal:** the human side of correctable memory.

**Shape:** a "Brief" section in stream settings adjacent to `companion-tab.tsx`: rendered markdown view, edit-in-place textarea (Shadcn primitives, INV-14), save via PUT with version (409 → inline "someone else edited" state, no toast). Timeline renderer `brief-updated-event.tsx` (template `memo-captured-event.tsx`): author, reason, expandable diff. Deep link from the event to the settings section.

**Files:** `stream-settings/brief-section.tsx` (+ registration in the settings tabs), `timeline/brief-updated-event.tsx`, `event-list.tsx`, `api/`, hooks.

**Tests:** component tests for editor save/conflict and event rendering (INV-39: real components, observable behavior).

**Done when:** a user can read, correct, and audit the brief entirely from the UI.

**Deviations (shipped):**

- **Shipped the settings editor; the timeline renderer moves to 4.2.** 4.3 landed ahead of 4.2 (in-app visibility was the priority), so the `stream:brief_updated` event it would render does not exist yet. Building a renderer for an event nothing emits is speculative (INV-36), so `brief-updated-event.tsx` + its `event-item.tsx` dispatch + deep-link ship in **4.2**, the step that introduces the event. 4.3's deliverable is the read/correct surface against 4.1's existing `GET/PUT` endpoints — a complete, observable user-facing surface on its own.
- **Section lives inside the Companion tab, not a new tab.** `BriefSection` renders at the bottom of `companion-tab.tsx` ("AI instructions and behavior" — the brief _is_ standing AI instructions), matching the Shape's "adjacent to `companion-tab.tsx`". No new settings tab/registration. Hidden on E2E streams (the PUT rejects them — §4.1 `BRIEF_E2E_UNSUPPORTED`), so the editor never offers a write that 400s.
- **Plain textarea + rendered-markdown view, not the rich editor.** The brief is markdown `TEXT` with no `content_json` twin (§4.1), so the editor is a `Textarea` (Shadcn, INV-14) and the view renders via `MarkdownContent` — unlike `description-section.tsx`, which round-trips ProseMirror JSON. If 4.3's editor ever goes rich-text, that's the §4.1 `content_json` follow-up.
- **Conflict UX keeps the user's text.** A 409 refreshes the known row to the writer's version (cache write) and shows an inline amber banner (no toast, INV-63) while keeping the editor open with the in-progress draft — saving again overwrites at the fresh version, or "load their changes" seeds the editor from the other version. Nothing is lost silently.
- **`STREAM_BRIEF_MAX_CHARS` moved to `@threa/types`** (from `brief-service.ts`) so the editor's char counter and the backend Zod cap share one source (INV-33); the service re-exports it so existing backend importers are untouched.
- **Author attribution + full revision-history browser deferred.** The read view shows the current version's freshness (`Updated <relative>`); per-change authorship (who + reason + diff) is the 4.2 timeline event's job, and a revisions-list browser would need a new endpoint over `stream_brief_revisions` (not built speculatively, INV-36). "Audit" in v1 = the current version is visible and correctable; richer audit arrives with 4.2's event.
- **New surfaces:** `api/stream-briefs.ts` (`streamBriefsApi` + `StreamBrief` wire type), `hooks/use-stream-brief.ts` (`useStreamBrief` query + `useUpdateStreamBrief` mutation, `streamKeys.brief`), `components/stream-settings/brief-section.tsx` (+ test). The brief is fetched on demand when settings open — it's not on the stream bootstrap envelope.

### 4.4 Brief correction eval

**Goal:** the correction loop actually works, measured.

**Shape:** eval calling production entry points (INV-45) with scripted conversations: (a) user states a durable decision → brief gains it; (b) user contradicts the brief → brief updated, not appended; (c) chitchat → no brief write. Config lives with the companion config (INV-44). Gate: ≥90% on (c) — over-eager brief writes are the failure mode that erodes trust.

**Files:** eval suite next to `companion/`, fixtures.

**Done when:** eval runs in CI (or the eval harness) with recorded baseline.

---

## Phase 5 — Local agent delegation (big rock 2)

The strategic bet: Threa is the shared-memory/coordination plane; the user's local agent is the execution plane. Depends on nothing earlier (the tool checklist from 1.1 helps). Template throughout: the bot-invocations claim pattern (`public-api/handlers.ts`, routes `routes.ts:714-833`, state machine queued → claimed (token) → steps → completed/failed, tests `sealed-claim.test.ts` et al.).

### 5.1 `delegate_task` tool + delegation substrate + INV-64

**Goal:** Ariadne compiles a hand-off into a durable, lifecycle-tracked delegation — tool and substrate in one logical unit, plus codifying the product invariant. This is the half where _Threa_ has better context than the local agent: she does the workspace research; the local agent does the execution.

**Shape:**

- Migration: `delegated_tasks` — `id` (`dlg_`), `workspace_id`, `stream_id`, `session_id` (creating session, nullable — users can delegate manually later), `source_conversation_id` (nullable — trigger message's primary conversation, same anchor as follow-ups; the later board-lens bridge: a status change bumps the owning conversation's `last_activity_at` so delegations ride the existing `conversation:*` sync path once board lenses land), `created_by_kind/id`, `title`, `brief` TEXT (the compiled hand-off prompt, markdown), `context_refs` JSONB (pointer URLs: `shared-message:`, `memo:`, `attachment:` — the syntax Ariadne already uses), `status` TEXT (`open|claimed|running|completed|failed|cancelled|expired`), `claim_token_hash`, `claim_expires_at`, `claimed_by_label` (free text: "Kris's MacBook / Claude Code"), `result_message_id`, timestamps. Status transitions CAS-guarded (INV-20).
- Service in new `features/delegations/` (INV-51 colocation): create/cancel/claim/heartbeat/complete/fail + expiry sweep (orphan-cleanup precedent: `orphan-session-cleanup.ts`). Broadcast events for **every** lifecycle transition — `delegation:created|claimed|status|completed|failed|cancelled|expired` (one status-carrying payload type; the expiry sweep emits `expired` in its own transaction) — appended in-txn so the card can never sit on stale state.
- Tool per the 1.1 checklist: `delegate_task`, input `{ title, brief, contextRefs }`. promptBlock guidance: the brief must be self-contained (assume the executor has repo access but zero Threa context); include acceptance criteria; link sources as pointer URLs rather than inlining walls of text; suggest delegation when the user describes work that is long-horizon, code-heavy, or local-filesystem-shaped — do not attempt such work in-session (INV-64). Tool is available in the live companion turn only (not inside the researcher sub-loop). Brief assembly reuses the context-bag machinery (`features/agents/context-bag/`) rather than a parallel compiler (INV-35).
- **Access ruling (from the #1118 exploration, adopted):** the brief resolves against the **requesting user's** access spec, not the persona's stream scope — the user owns the local agent and its credentials, so the hand-off may carry only what they can see. And **delegation from E2E streams is disabled in v1**: a server-built plaintext brief cannot egress a sealed stream (revisit with the sealed wire).
- **Decision to make in-step:** dedicated `delegated_tasks` table (as specced) vs reusing `bot_invocations` + a `task-executor` trait (#1118's sketch — its claim/TTL/retry machinery already exists). Default to the dedicated table (lifecycle and fields differ: claimed by a _person's_ agent via the public API, person-facing card, `brief`/`context_refs`/`result_message_id`), but record the alternative and mirror its mechanics.
- CLAUDE.md: add INV-65 (sessions minutes-bounded; long-horizon work delegates) with pointer here. _(Was specced as INV-64; that id was claimed by mentions/actor-refs first.)_

**Files:** migration, `features/delegations/{repository,service,index}.ts`, types constants/domain, tool file + test, `tool-deps.ts`, barrel, `tool-set.ts`, `built-in-agents.ts`, CLAUDE.md.

**Tests:** state-machine transitions incl. claim-vs-cancel race, expiry sweep; event presence; tool creates row + event; tool refused when stream policy denies the category.

**Done when:** "can you get someone to actually build this?" yields a lifecycle-tracked delegation row with a coherent, self-contained brief and a visible `delegation:created` event.

**Deviations (shipped, together with 5.2 in one PR):**

- **Event shape:** not seven event types. `delegation:created` is the one broadcast row (slot-consuming, INV-61, in `STREAM_ROW_SPEC` as a board-joining `source-conversation` row); every later transition is ONE patch type, `delegation:status_changed`, carrying `{status, claimedByLabel?, resultMessageId?, statusNote?}` — exactly the follow-up scheduled/cancelled row-vs-patch split, so a status change repaints the card instead of appending a redundant second row. The frontend correlates via `collectDelegationStatusPatches` (last patch wins), the sibling of `collectCancelledFollowUpIds`.
- **The created payload snapshots `title`/`brief`/`contextRefs`** — immutable after create, so the card and 5.2's Copy-prompt need zero fetch.
- **`contextRefs` are validated, not "assembled via context-bag":** the spec's "brief assembly reuses the context-bag machinery" conflated two ref systems — context-bag refs are structured `{kind, streamId}` objects; a delegation's refs are pointer URLs (`shared-message:`/`memo:`/`attachment:`). What's actually shared is the _access discipline_: `validateDelegationContextRefs` (`features/delegations/context-refs.ts`) mirrors `stripInaccessibleAgentRefs`' per-kind decisions against the invoking user's `accessibleStreamIds`; drops are reported back to the model in the tool result.
- **Companion-only + refusals are bind-time, not runtime:** the tool's deps bundle is simply absent on sealed streams (`stream.e2eEnabled`, the #1118 ruling) and on turns without a human trigger, so the tool never appears in those tool sets (same mechanism that keeps it out of the researcher sub-loop and `GENERAL_RESEARCH_TOOL_POLICY`).
- **Dedicated-table decision confirmed;** mechanics mirror bot-invocations (CAS transitions, TTL'd claim, sha256 token-at-rest via `hashCallbackToken`) but with sweep-based expiry: `createDelegationExpirySweep` (orphan-cleanup `setInterval` shape) CASes lapsed claims to `expired` set-based (INV-56) and appends each card's patch in the same tx. A lapsed-but-unswept claim is NOT reclaimable (unlike bot-invocations' reclaim-in-claim-SQL) — the sweep emits the visible `expired` transition first; re-claiming an expired task is a 5.3 decision.
- **No pending cap** (unlike follow-ups 1.1) — deliberate; a delegation is high-friction to create and trivially cancellable. Revisit if abuse shows up.
- **Machine transitions (claim/running/complete/fail/expired) act as `system`** with no `actorId` (like `memos:captured`); `claimedByLabel` on the payload carries the executor's human-readable identity.

### 5.2 Delegation card UI

**Goal:** the multiplayer-visible surface: everyone sees the task, who claimed it, and its state.

**Shape:** `timeline/delegation-event.tsx` rendering all statuses from the status-carrying payload (one component, variant by status — INV-29/43). Actions: **Copy prompt** (compiles brief + context into one paste-ready prompt; confirm in place by swapping the icon to a checkmark, same footprint — INV-63/21), **Cancel** (creator or stream member with access), and a collapsed "how to run this locally" hint. Completed state links `result_message_id`.

**Files:** timeline component + test, `event-list.tsx`, `api/delegations.ts`, hooks.

**Tests:** component test across statuses; copy-prompt content assembly; INV-63 guard stays green (no success toast).

**Done when:** the copy-prompt path works end-to-end with zero local tooling installed — the day-one delegation story.

**Deviations (shipped with 5.1):** dispatched from `event-item.tsx` (where the follow-up/memo cards dispatch), not `event-list.tsx`. Cancel is backed by a new first-party endpoint `POST /api/workspaces/:wid/delegations/:id/cancel` (`features/delegations/handlers.ts`, `checkStreamAccess`-gated, 404 hides existence — the follow-up-cancel template). The "how to run this locally" hint is one line under the expandable hand-off prompt ("paste into your local agent"); the claim-via-API instructions arrive with 5.3, which is when they become true (INV-36). The brief is shown as source text (mono, pre-wrap) — what you read is exactly what Copy ships.

### 5.3 Delegation public API (claim/status/complete)

**Goal:** local agents close the loop programmatically.

**Shape:** mirror bot-invocations exactly: `POST /api/v1/workspaces/{wid}/delegations/{id}/claim` (API-key auth → returns brief + context + `claimToken` + expiry; CAS `open → claimed`), `POST …/heartbeat`, `POST …/status` (running + free-text progress note → card updates via outbox), `POST …/complete` (result markdown → service posts a message to the stream authored by the claiming identity, links `result_message_id`, CAS to `completed`), `POST …/fail`. Callback-token binding per the sealed-claim pattern (`X-Threa-Callback-Token`). The completion message enters the normal pipeline — GAM memorizes the outcome, which is the whole point. OpenAPI: `bun apps/backend/scripts/generate-api-docs.ts` regeneration; extend the `threa-public-api` skill notes. **Client-side decision for 5.4/5.5:** these endpoints sit next to — but are distinct from — the bot-runtime claim API that `@threa/remote-session`'s `ThreaClient` wraps; decide whether `ThreaClient` grows delegation methods or a sibling client is cleaner, and record it.

**Files:** `public-api/{routes,handlers}.ts` additions delegating to `features/delegations/service`, OpenAPI regen, docs.

**Tests:** follow the sealed-claim test suite shape: claim races, token binding, expiry, complete-posts-message.

**Done when:** a curl script can claim, report progress, and complete a delegation, with each transition visible on the card.

### 5.4 Connector-SDK delegation support (`@threa/remote-session`)

**Goal:** one-command hand-off for local agents — generic in the SDK, so every connector inherits it.

**Shape:** _(reshaped after #1153 extracted `@threa/remote-session`; the original target — "extend `extensions/claude-code-remote`" — is stale.)_ The delegation loop (poll/fetch open delegations → claim → run with the brief as prompt → complete/fail with the result) is runtime-agnostic and structurally identical to the scratchpad claim-drain `RemoteSession` already runs (claim drain, busy semantics, renewal, complete/fail). Put the **generic delegation runner in `extensions/remote-session`** — a `DelegationRunner` (or a `RemoteSession` mode) driving the 5.3 endpoints via the client decided in 5.3 — with `claude-code-remote` contributing only its Claude-specific `deliverTurn`/actuator, and `pi-remote` picking it up when it adopts the SDK (deliberately deferred in #1153). Card's "Run locally" hint documents the command. Keep connectors thin — all state lives server-side in `delegated_tasks`.

**Files:** `extensions/remote-session/` (runner + client), `extensions/claude-code-remote/` (thin consumer + README), delegation card hint copy.

**Tests:** SDK runner tests against a stubbed API (claim races, busy, complete/fail); claude-code-remote integration test with a stubbed runner; manual end-to-end run recorded in the PR.

**Done when:** `threa-remote delegate <id>` (or equivalent) executes a delegation locally through the SDK runner and the card shows claimed → completed with the result linked — with zero delegation logic inside claude-code-remote itself.

### 5.5 `@threa/mcp` server

**Goal:** every local agent — not just ours — can pull Threa context and close delegations. One integration on our side instead of integrating everywhere.

**Shape:** new package `packages/mcp/` (bun, stdio MCP server) wrapping the public API: tools `search_messages`, `search_memos`, `get_stream_messages`, `read_attachment`, `post_message`, `list_delegations`, `claim_delegation`, `complete_delegation`. Auth via env API key. No business logic — a thin authenticated proxy; scoping is enforced server-side by the API key's workspace. Docs page under `docs/public-api/` with Claude Code `mcpServers` config example. Still greenfield (no `packages/mcp` exists), but two in-repo precedents to copy, not rebuild: `claude-code-remote` already ships a stdio MCP server (server construction, tool registration, stdio transport — `src/channel-server.ts`; note it serves _live-session channel tools_, a different surface than this public-API proxy), and the harness-daemon's session-scoped `--mcp-config` injection (`harness-daemon/src/spawners.ts` `writeMcpConfig`) is the wiring precedent for pointing a local agent at an MCP server without global registration.

**Files:** `packages/mcp/`, root workspace registration, docs.

**Tests:** tool-schema round-trip tests against stubbed HTTP; manual Claude Code session in the PR notes.

**Done when:** a local Claude Code with the MCP server configured can search workspace memos and complete a delegation without any Threa-specific extension.

---

## Phase 6 — Memory: agent-authored + scoped memos + hygiene (big rock 3)

Completes GAM into the two-tier private/shared shape (Collaborative Memory, arXiv 2505.18279). Steps 6.1 and 6.5 are independent quick wins; 6.2 → 6.3 and 6.4 are ordered.

### 6.1 Memo edit/archive endpoints + explorer UI

**Goal:** correctable shared memory — the missing HTTP surface over existing repo capability.

**Shape:** `MemoRepository` already has `UpdateMemoParams` and `archived_at` (`memos/index.ts:5`); `explorer-service.ts` exposes only search/getById (premise re-verified 2026-07-06, post-#1187). Add `update` (title/abstract/keyPoints/tags) and `archive`/`unarchive` to the service + `PATCH /api/workspaces/:wid/memos/:id` + archive endpoints, access-gated by the memo's source-stream accessibility (same spec as `getById`). Explorer UI (`pages/memory.tsx`, `memo-detail.tsx` — currently zero edit affordances): edit-in-place for text fields, archive button. Non-active statuses are now **two** since #1187's memo supersession (`archived` + `superseded`, both already in `MEMO_STATUSES`) — the explorer's filters must handle both (a superseded memo should link its `parent_memo_id` successor), and both stay excluded from retrieval by the existing status handling. Re-embed on content edit (enqueue the existing embedding job).

**Files:** `memos/{explorer-service,handlers}.ts`, `routes.ts`, `memo-detail.tsx` + hooks/api, embedding enqueue.

**Tests:** endpoint access gating; edit triggers re-embed job; UI component test.

**Done when:** a wrong memo can be corrected or retired from the explorer, and retrieval reflects it.

**Deviations (shipped):**

- **Edit/archive live on `MemoExplorerService`, not `MemoRepository.update` directly.** New `update` / `archive` / `unarchive` methods reuse a private `resolveAccessibleMemo` gate (identical to `getById`: source-stream accessibility via `loadSourceContext`, workspace check). `update` re-embeds whenever the abstract is part of the update (not on a diff against a pre-read value) so the stored embedding always matches the stored abstract even under a concurrent edit — the pre-read-then-compare was a self-review finding (INV-20): it could leave abstract V1 with embedding V2. The AI `embed` runs before the write transaction (INV-41), which does `MemoRepository.update` + `updateEmbedding` together. The client sends only changed fields, so a title/tags-only edit skips the embed and doesn't overwrite a field it never touched. All three return the rebuilt `MemoExplorerDetail`.
- **`getById` no longer gates on `status = 'active'`.** The explorer must render archived/superseded memos to un-archive/inspect them, so the status filter was dropped from `getById` (access is still gated). This also relaxes the v1 public `GET …/memos/:id` and the `describe_memo` tool, both of which share the handler — access unchanged, only the retired-status exclusion lifted.
- **Status is a search-filter, defaulted to `["active"]` in the repo.** `MemoSearchFilters.statuses` threads through `fullTextSearch` / `hybridSearch` / `exactSearch` (`m.status = ANY($statuses)`). Because it defaults to `["active"]` when unset, the researcher's retrieval path is byte-unchanged — only the explorer opts into `archived` / `superseded`. Resurrection is blocked at both ends: `archive` is guarded on `status = 'active'` and `unarchive` on `status = 'archived'`, so a `superseded` memo can never be flipped to `archived` and then restored into retrieval (self-review finding — the UI only offers Archive on active memos, Restore on archived, neither on superseded).
- **Superseded → successor link.** `MemoExplorerDetail.successorMemoId` (reverse lookup `findSupersededBy` on `parent_memo_id`, active only) surfaces on the detail so a superseded memo deep-links to the capture that replaced it. Added to the v1 `memoDetailSchema` (openapi regenerated).
- **Edit caps in `@threa/types`.** `MEMO_TITLE_MAX_CHARS` (= the memorizer's generation cap, 100) / `MEMO_ABSTRACT_MAX_CHARS` / `MEMO_KEY_POINTS_MAX` / `MEMO_TAGS_MAX` (re-exported from `memos/config.ts`) back the backend Zod validator (and the char caps also the editor's counter), one source of truth (INV-33), mirroring `STREAM_BRIEF_MAX_CHARS`.
- **UI: opt-in `edit` prop on the shared `MemoDetailContent`.** The memory explorer passes edit controls (edit-in-place form for title/abstract/keyPoints/tags + Archive/Restore); the in-stream `MemoPreviewDialog` omits it and stays read-only (INV-15/18 — `MemoEditForm` and `MemoStatusBadge` are sibling components, not nested). A "Status" filter chip (Active/Archived/Superseded, default Active, kept out of the URL when Active per INV-59 default-view convention) lets the user browse retired memos. No `toast.success` — the form→view swap and list refresh are the confirmation (INV-63); failures `toast.error`.
- **First-party endpoints only:** `PATCH /memos/:id`, `POST /memos/:id/{archive,unarchive}`. No v1 mutation surface (edit/retire is a person action, not an integration one) — consistent with the explorer being a first-party UI.

### 6.2 `save_memo` tool

**Goal:** explicit "remember this."

**Shape:** tool per the checklist; input `{ title, abstract, keyPoints, tags, knowledgeType, sourceMessageIds }`. Writes through `MemoService` (reuse dedup + embedding pipeline — INV-35, no parallel write path). Provenance needs a migration, NOT a `memo_type` value: `memo_type` is `message|conversation` (`packages/types/src/constants.ts:349`) with the `memo_type_source` CHECK tying it to `source_message_id`/`source_conversation_id` (`20251226203429_memos.sql:44-47`), so `memo_type: 'agent'` would violate the constraint. Add `authored_by_kind` TEXT default `'pipeline'` (`pipeline|agent`) + nullable `source_session_id`; `save_memo` keeps `memo_type` semantics from its `sourceMessageIds` and sets `authored_by_kind: 'agent'`. Same-transaction `memos:captured` broadcast event — the INV-62 rule applies to agent writes identically. Structural boost: agent memos get a multiplier below conversation-sourced ones (`MEMO_KNOWLEDGE_TYPE_BOOST` sibling constant in `memos/config.ts`) to damp self-reinforcement.

**Files:** types, tool file + test, `tool-set.ts`, `built-in-agents.ts`, `memos/{service,config}.ts`.

**Tests:** dedup against an existing near-identical memo; boost ordering; capture event presence.

**Done when:** "remember that we deploy on Fridays only after the smoke suite" produces a visible, deduped, retrievable memo.

### 6.3 Reflective capture at session completion

**Goal:** research work products stop evaporating with turn digests.

**Shape:** post-completion job (alongside 3.1's summary job): run the existing `MemoClassifier` over the session's tool-work digest + final reply; if above `MEMO_GEM_CONFIDENCE_FLOOR`, extract ≤2 memos via the existing `Memorizer` path with `authored_by_kind: 'agent'` and `source_session_id` provenance (columns from 6.2). Reflective memos may lack a message/conversation source, so the 6.2 migration also extends the `memo_type_source` CHECK with a session-sourced alternative (new migration — append-only, INV-17). No new models, no new prompts beyond a digest-shaped input adapter — this is a second _caller_ of the pipeline, not a second pipeline (INV-35).

**Files:** `companion/session.ts` enqueue, small adapter in `memos/`, config cap.

**Tests:** classifier-gated (low confidence → no memo); cap respected; events present.

**Done when:** a research-heavy session leaves behind at most two well-formed agent memos, visibly captured.

### 6.4 `memoScope` (user/stream/workspace)

**Goal:** the private/shared tier split.

**Shape:** migration adds `scope` TEXT default `'workspace'` + `scope_user_id` nullable (set when `scope='user'`). `workspace_id` stays required regardless of scope (INV-8) — `user` scope subdivides _within_ the workspace boundary, it is not a global private store. Write policy: memos extracted from DMs/private scratchpads default to `user` scope for the owning user (extractor config change); `save_memo` gains an optional scope arg. Retrieval: `hybridSearch`/`semanticSearch` (`memos/repository.ts:527,671`) gain a scope predicate — `user`-scoped memos visible only when the invoking user matches (from `computeAgentAccessSpec`'s invoking context); stream/workspace scopes keep the existing access-spec filtering. Explorer: "About you" filter showing the user's private-tier memos, with delete — the "what Ariadne knows about you" panel.

**Files:** migration, `memos/{repository,service,config}.ts`, `researcher/access-spec.ts` (carry invoking user), explorer UI filter.

**Tests:** the recurring footgun test — a user-scoped memo never surfaces in another user's DM or a shared channel; backfill default sane.

**Done when:** per-user knowledge exists, retrieves only for its user, and is user-visible/deletable.

### 6.5 Retrieval feedback decay

**Goal:** close the loop that keeps shared memory trustworthy as it grows.

**Shape:** cited memo sources on agent replies get a compact 👎 affordance (message sources UI already renders citations). Feedback rows in a small tracking table (`memo_feedback`: memo id, user id, signal, created*at — INV-57); retrieval applies a decay multiplier per net-negative memo (constant in `memos/config.ts`, floor so nothing fully vanishes without archival). No 👍 needed in v1 — absence of complaints is the positive signal. Priority note: #1187's capture-time supersession already kills the paraphrase-stacking failure mode this partially targeted — 6.5 remains worthwhile for \_wrong/stale* memos users notice at retrieval time, but it's the least urgent Phase 6 step now.

**Files:** migration, `memos/{repository,config}.ts`, sources UI affordance, endpoint.

**Tests:** decay ordering in hybrid search; idempotent per-user feedback (INV-20 upsert).

**Done when:** a twice-downvoted memo demonstrably ranks below an equivalent un-downvoted one.

---

## Phase 7 — Persona picker

Code-complete backend machinery (`applyBuiltInAgentPatch`, `agent_config_overrides`), no UI. Independent.

### 7.1 Workspace persona CRUD API

**Goal:** HTTP surface over the overrides machinery.

**Shape:** endpoints to list personas (built-ins + workspace overrides), create/update a workspace persona (name, emoji, system prompt, model from `docs/model-reference.md` allowlist, `enabledTools` subset), archive. Zod schemas derived from the `built-in-agents.ts` persona schema (INV-31). Guard: `EMPTY_AGENT_ID` not editable.

**Files:** `features/agents/{persona-handlers,routes-wiring}`, reuse `agent-config-override-repository.ts`.

**Tests:** override round-trip; model-allowlist rejection; tool-subset validation.

### 7.2 Persona picker UI

**Goal:** choose the companion per stream; make first-party personas and external bots legible in one place.

**Shape:** `companion-tab.tsx` gains a persona select (streams already carry `companionPersonaId`) listing built-ins + workspace personas, plus a link to a small workspace-settings persona editor (create/edit per 7.1). External bots noted in the same tab via the existing `ExternalAgentIndicator` — one mental model: "who works in this stream."

**Files:** `companion-tab.tsx`, new workspace-settings persona editor page/section, hooks/api.

**Tests:** component tests: pick persists; editor validation mirrors API errors.

**Done when:** a workspace can run "Ariadne" in one stream and a custom persona in another, picked from the UI.

---

## Phase 8 — Bounded passive following (deliberately last)

Depends on Phase 1 (follow-up plumbing), **step 1.5 (turn-purpose union — an ambient turn is invocation kind #5 and must be a `purpose` member, not another optional field)**, and Phase 4 (the brief gives ambient work somewhere durable to land). Proactivity done wrong erodes trust fastest — hence last, budgeted, and off by default outside scratchpads.

### 8.1 Ambient classifier on settled conversations

**Goal:** a cheap ambient pass that decides if anything is worth surfacing.

**Shape:** piggyback the exact settlement signal the memo pipeline uses: `StreamStateRepository.findStreamsReadyToProcess` (5-min cap / 30-s quiet, `memos/batch-worker.ts`) → `MEMO_BATCH_PROCESS`, with per-conversation granularity from the drained `PendingItem` rows. Note the coupling this inherits: the signal only fires for streams with `memory_mode` on, so ambient requires memory automation on — document that in the settings copy rather than building a second debounce. For companion-on streams with ambient enabled: haiku-class classifier (INV-54 — model decision, no keyword heuristics) over the settled conversation + current brief, output one of `none | update_brief | surface_memo | flag_unanswered` with confidence. High floor (start 0.85). `update_brief` routes through the 4.2 tool path in a lightweight session; `surface_memo`/`flag_unanswered` produce 8.2 cards. All decisions traced + telemetry (INV-19).

**Files:** `features/agents/ambient/{classifier,config,handler}.ts` colocated (INV-51), hook into memo batch completion, `companion/config.ts`.

**Tests:** classifier eval fixtures (see 8.3); budget respected; disabled stream → no-op.

### 8.2 "Ariadne noticed" card + budget + toggle

**Goal:** the surfacing itself, strictly rationed.

**Shape:** budget: max 1 proactive card per stream per day (tracking table `ambient_budget` or a count query on the event table — prefer the query if cheap; INV-36 no speculative config). New broadcast event + dismissible timeline card (dismiss is per-card, persisted). Settings: ambient toggle in `companion-tab.tsx`, default on for scratchpads, off elsewhere. Card copy states why it surfaced ("this question has been open for a day") with the action inline (open memo / jump to message / see brief change). The Needs-resolution lens **has shipped** (#1178), so `flag_unanswered` feeding it via `conversation.status='stalled'` is live territory — but there is now a **second status writer**: #1187's staleness sweep sets `stalled` at 24h idle for a different reason (idleness vs. unanswered question). Decide in-step how they coexist — likely a reason-carrying field alongside status, or ambient only _accelerating_ the sweep's transition — so neither writer clobbers the other's semantics and the lens can distinguish if it ever needs to.

**Files:** types events, timeline component, `companion-tab.tsx`, budget check in ambient handler.

**Tests:** budget cap enforced across concurrent settlements (INV-20); dismiss persists; toggle gates.

### 8.3 Ambient precision eval

**Goal:** measured precision before this ships anywhere real.

**Shape:** eval over fixture conversations (real-shaped: questions answered later, questions never answered, chitchat, decision-then-contradiction) calling the production classifier (INV-45). Gate: false-positive rate on "should stay silent" fixtures < 5% before default-on for scratchpads.

**Done when:** the eval baseline is recorded and the classifier meets the silence gate.

---

## Backlog (proposed in the exploration doc, not yet scheduled)

Small items from `docs/ariadne-vs-claude-tag-exploration.md` deliberately left out of the scheduled steps — listed here so they're deferred, not lost:

- **`create_thread` / `create_scratchpad` tools [S]** (exploration §4.2) — pure Threa writes, high collaborator feel. Deferred until the Phase 1 durable-write pattern has landed; they then follow the same checklist as a one-step addition (slot as 1.5 or alongside Phase 4).
- **BYO-bots vs delegation positioning paragraph [docs/S]** (exploration §4.5.5) — one paragraph in `docs/features/public/` distinguishing persistent workspace bots from one-shot delegation to a personal agent. Write it when Phase 5 ships user-visible delegation (5.2), when the distinction becomes real.
- **Board-surface integration for delegations/ambient flags** — structural lenses **shipped** (#1178) and #1179 (in flight) establishes the shared stream-row spec that renders agent traces, reminders, and memo captures on board surfaces. When delegations (5.1/5.2) and ambient cards (8.2) land, they join that row spec anchored on `source_conversation_id` — no bespoke bridge. The personal "Mine" lens is still pending (#1193 in flight).
- **Per-persona/workspace token-spend budgets** (#1118 salvage) — cost accounting over the existing `agent_sessions`/`agent_session_steps` trace + a soft budget with loud failure (INV-11). Low urgency while everything is reactive; **should ship with or before Phase 8** — proactive agents spend money unattended, so the guardrail belongs alongside ambient.
- **Recurring scheduled runs** (#1118 salvage) — "every Monday, summarize what moved"; cron-shaped recurrence on top of the follow-up substrate (a `recurrence` rule that re-arms on fire, or a sibling `agent_schedules` table). One-shot follow-ups deliberately shipped first; add recurrence only on real demand (INV-36).
- **Conversational memory control** (#1118 salvage) — "forget that" / "that's wrong, we chose X" handled in-band by Ariadne via `archive_memo`/`correct_memo` tools over the 6.1 service surface. A natural 6.x follow-on once 6.1's endpoints exist; the explorer covers the deliberate path, this covers the conversational one.
- **Cross-stream synthesis as a named action + reply provenance polish** (#1118 salvage, small) — promote `workspace_research` to a visible "Ask across my workspace" affordance, and a one-tap "based on N memos / M messages" on agent replies (sources already attached). Positioning-level wins; schedule opportunistically.
- **Per-stream follow-up limit column** — deferred from 1.4 until a real need (INV-36); the `resolveFollowUpLimit()` seam makes it small.
- **"Reminders" in the stream-context surfaces (pending-follow-up list)** — extends 1.3's timeline card. Surface a stream's _pending_ follow-ups as their own filter chip/category (`"Reminders"`) in the "In this stream" panel (`apps/frontend/src/components/stream-context/stream-context-panel.tsx`; the panel is filter-chips over a day-grouped feed, so this is a new chip + a `StreamContextRow` variant, each row with the same Cancel affordance as the timeline card). **Must be authoritative, not timeline-derived:** a new access-gated `GET /api/workspaces/:workspaceId/agent-follow-ups?streamId=&status=pending` over `AgentFollowUpService.listPending` (mirror the 1.3 cancel handler's `checkStreamAccess` gate) + a frontend query — deriving from loaded `agent:follow_up_scheduled` events the way the panel derives links/files would wrongly keep a follow-up that already **fired** (fire CASes `pending→fired`, but there is no `fired` timeline event) and would miss out-of-window rows. Full-feature requirements the user called out:
  - **Live updates.** Invalidate/refetch on the `agent:follow_up_scheduled` / `agent:follow_up_cancelled` socket events (already delivered to the client by 1.3). **Gap to close:** firing has no broadcast today, so a fired follow-up won't live-drop from the list — this step must add a lightweight fire signal (either an `agent:follow_up_fired` patch event, or an outbox nudge that just invalidates the query) rather than falling back to focus/interval refetch.
  - **Board + conversations parity (suspected unsupported — confirm).** The board (`pages/board.tsx`) and conversations views render conversations/board-posts, not timeline broadcast rows, so they almost certainly don't show follow-ups today. Design one shared authoritative "pending follow-ups for this stream/conversation" source that the timeline panel, the board, and the conversations view all read (anchor board/conversation grouping on the follow-up's `source_conversation_id`, per the Adjacent-systems note that follow-up cards are timeline-event-shaped and bridge to the board via `source_conversation_id` — don't mint a second card data plane).
  - Depends on 1.3 (#1176): the event types, the cancel endpoint, and `listPending`.
- **`workspace_research` querying episode summaries** — deferred from 3.1. The researcher (`features/agents/researcher/researcher.ts`) is a retrieval loop with no single stream-context preamble to extend cleanly, so surfacing a stream's `episode_summary` rows as a research source is its own small step (add them to the researcher's stream-context assembly next to the recent-messages fetch). The companion read path (3.1) already carries them into normal turns.
- **Enclave/E2E parity for `schedule_follow_up`** — 1.1 wires the tool into the plaintext companion toolset only; the enclave's `buildEnclaveTools` (`apps/enclave/src/agent/tools.ts`) deliberately omits it, so E2E scratchpads silently don't offer it (clean degrade, no leak). Full parity needs two pieces: (a) the `note` is E2E-derived plaintext, so `agent_follow_ups.note` would have to be **sealed** (encrypted to the stream key, decrypted only inside the enclave at fire time) instead of stored plaintext; (b) firing must dispatch to the **enclave** (sealed dispatch) rather than enqueuing a plaintext `PERSONA_AGENT` job that holds no stream key. A per-tool follow-up under the general "E2E/enclave parity for new tools" item below.

## Deliberately out of scope

- **Long-horizon in-app sessions** — the anti-goal; see INV-64 (5.1).
- **Token-streaming the final reply** — the trace card is the liveness surface; revisit only if user feedback demands it.
- **External write tools (Linear/GitHub mutations)** — needs a per-action confirmation UX and an app-identity story first; nothing in this roadmap blocks it later.
- **E2E/enclave parity for new tools** — sealed-delivery streams keep the stripped-down enclave toolset; each new tool's enclave story is a per-tool follow-up decision, not assumed.
