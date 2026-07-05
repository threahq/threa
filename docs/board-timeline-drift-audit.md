# Board × Timeline event-rendering drift — audit + recommendation

Status: audit memo (2026-07-04). Sibling to
[`board-view-design.md`](./board-view-design.md); this is the "why do we have to
wire events into two views" question, answered with code.

Produced by a Sonnet-map / Opus-design / Opus-judge workflow, then the
load-bearing claims were re-verified by hand against the code (see
"Verification" at the end).

## Executive summary

- **The drift is real and structural, not cosmetic.** The timeline dispatches
  ~11 visible row kinds through one switch (`event-item.tsx:68`); the board
  renders exactly one (`MessageItem`) because its data source is a single hard
  Dexie filter — `db.events.where("[streamId+eventType]").equals([streamId,
"message_created"])` (`use-board-card-messages.ts:127`). Every non-message
  event is excluded **before any component runs**. Board components contain **0**
  `eventType` references (grep-confirmed).
- **User-visible consequence:** agent traces (`agent_session:*`), scheduled
  reminders (`agent:follow_up_scheduled`), and memory captures (`memos:captured`)
  render in the timeline but are invisible on the board/panel for the _exact same
  conversation_. Agent-triggered-from-a-card looks dead until the final reply
  lands.
- **Root cause:** there is no shared "renderable stream row" model. The timeline
  has an _implicit_ registry (a switch plus ~8 scattered type-sets); the board has
  _no_ registry at all. Adding one row kind = editing 4–8 places in the timeline
  and 7 more in the board — with no compiler forcing the second view.
- **Proof it's live drift, not theory:** commit `caae3643` (scheduled
  follow-ups, roadmap 1.3, 3 days ago) touched only timeline files — zero
  board/panel edits — and silently doesn't work on the board. Landing a timeline
  feature required _zero awareness_ the board exists.
- **Recommendation: synthesize.** Take the structural proposal's SSOT device (an
  **exhaustive `Record<EventType, RowSpec>` in `packages/types`** — a compile
  error is the only thing that stops the _next_ drift) with the minimal proposal's
  staging discipline (ship agent-on-board fast; do **not** big-bang the timeline
  switch). Reject a frontend-only `Partial<Record>` as the SSOT — it silently
  omits, which is the failure mode we're fixing.
- **The three agent surfaces fall out for free:** once the spec's
  `conversationRef` axis exists, `memos:captured`→`payload.conversationId`,
  `follow_up_scheduled`→`sourceConversationId`, `agent_session:*`→`triggerMessageId`
  each resolve to a conversation with render-only semantics (`bumps:false`),
  reusing the existing row components unchanged.
- **Scope guard:** do NOT merge `MessageItem`/`MessageEvent`, do NOT touch backend
  membership/bump/delivery-groups, do NOT port live step-tickers in step 1. The
  one real risk: the new "reset author-run on an interleaved row" logic (the board
  has never needed it) must be tested.

## 1. Drift audit (cited)

**The mechanism.** Two pipelines read the same `db.events` table with different
scope:

- Timeline: `useStreamEvents` loads the _full_ per-stream window
  (`stream-store.ts:86`, index `[streamId+_sequenceNum]`), then `EventItem`
  dispatches per type (`event-item.tsx:68`, ~15 arms).
- Board: `useBoardCardMessages` loads a _type-filtered_ window —
  `message_created` only (`use-board-card-messages.ts:127`) — projects via
  `eventToRenderable` (message-only, `:26`), renders `<MessageItem>` inline with
  no dispatch (`board-card.tsx:214-250`, `conversation-panel.tsx:332-349`).

This is not a render gate the board could relax; the rows **never enter the data
structure**. Confirmed: 0 `eventType` refs anywhere under `components/board/` or
in `conversation-panel.tsx`.

**Concrete user symptoms:**

1. _Agent working, board looks dead._ Trigger an agent from a card — nothing
   shows until the final reply (`message_created`) lands. The running session card
   is right there in the timeline. (`agent_session:*` never enters the rail.)
2. _A just-scheduled reminder is invisible off the timeline._ The `caae3643`
   Cancel-able scheduled-follow-up card exists only in
   `event-item.tsx`/`event-list.tsx`. Zero board wiring.
3. _Memory capture is invisible on the surface built to close the loop._ GAM
   captures a memo from a conversation's source stream; timeline shows the
   "captured" row (INV-62 "visible in situ"), the board card for that same
   conversation shows nothing — even though the doc's own "Decisions/Knowledge"
   lens is _defined_ as "conversations with a captured memo"
   (`board-view-design.md:168-169`).

**Compact drift matrix** (24 `EVENT_TYPES` at `constants.ts:91-116`):

| Event type                                       | Timeline row                    | Board / panel         | Conv. member        | Bumps activity | Bcast slot |
| ------------------------------------------------ | ------------------------------- | --------------------- | ------------------- | -------------- | ---------- |
| `message_created`                                | ✓ MessageEvent                  | ✓ (only type carried) | ✓                   | ✓              | ✓          |
| `agent_session:started/completed/failed/deleted` | ✓ grouped (`AgentSessionEvent`) | **✗**                 | ✗                   | ✗              | ✓          |
| `memos:captured`                                 | ✓ `MemoCapturedEvent`           | **✗**                 | ✗ (provenance only) | ✗              | ✓          |
| `agent:follow_up_scheduled`                      | ✓ `FollowUpScheduledEvent`      | **✗**                 | ✗                   | ✗              | ✓          |
| `agent:follow_up_cancelled`                      | patch (null)                    | ✗                     | ✗                   | ✗              | ✗          |
| `member_joined/added/left`                       | ✓ `MembershipEvent`             | ✗ (correct)           | ✗                   | ✗              | ✓          |
| `description_set`                                | ✓                               | ✗ (correct)           | ✗                   | ✗              | ✓          |
| `stream_archived/unarchived`                     | ✓ `SystemEvent`                 | ✗ (correct)           | ✗                   | ✗              | ✓          |
| `messages:moved`                                 | ✓ source-side                   | ✗                     | stale-risk          | ✗              | ✓          |
| `command_*`                                      | ✓ grouped, author-scoped        | ✗ (correct)           | ✗                   | ✗              | ✗          |
| `message_edited/deleted`, `reaction_*`           | patch                           | patch                 | n/a                 | ✗              | ✗          |

Rows 2–4 (bold ✗) are the wrong-absence — conversation-scoped agent activity that
_belongs_ on the board. Rows 6–12 are correct-absence (channel chrome, not topic
content) — but the board has no way to express even that as a decision; it's an
accident of the Dexie filter.

## 2. Root cause (named precisely)

**There is no shared "renderable stream row" model.**

- The timeline's renderability knowledge is an _implicit registry_ smeared across
  ≥8 sites, each with a distinct failure mode if you miss it: `EVENT_TYPES`
  (`constants.ts:91`), `TIMELINE_BROADCAST_EVENT_TYPES` (`constants.ts:141`),
  `COMMAND_EVENT_TYPES`/`AGENT_SESSION_EVENT_TYPES` (`constants.ts:120,485`), the
  `EventItem` switch (`event-item.tsx:68`), `MESSAGE_EVENT_TYPES`
  (`event-list.tsx:163`), `ZERO_HEIGHT_EVENT_TYPES` (`event-list.tsx:304`),
  `groupTimelineItems` slot logic (`event-list.tsx:533`),
  `THREAD_HIDDEN_EVENT_TYPES` (`stream-content.tsx:106`), plus backend
  `enrichBootstrapEvents` filtering (`event-service.ts:1730`).
- The board has **no registry** — it hard-filters to messages at the Dexie layer,
  so it can't even drift _toward_ the timeline. It's blind to 23 of 24 types
  before rendering logic exists.

Net: adding a conversation-scoped row kind touches **4–8 timeline sites and 7
board sites**, none enforced by the type system. Nothing makes "wire it into both
views" a requirement. That's the drift generator.

## 3. Recommendation — synthesize the SSOT device with staged rollout

**Pick the structural proposal's location and exhaustiveness for the SSOT; pick
the minimal proposal's discipline for the rollout.**

Why not a partial frontend table: a `Partial<Record<EventType,
BoardEventRowSpec>>` in `components/board/` _silently omits_ — a future
`EVENT_TYPE` that forgets an entry just doesn't render, which is **exactly today's
failure mode**. It fixes the three known cases but doesn't make the _next_ drift
impossible.

Why not big-bang the whole timeline first: ripping the `EventItem` switch out and
re-routing the whole timeline through a renderer registry in the same arc is the
correct endgame, but it's a large, higher-risk change that is **not required** to
put agent activity on the board. The drift for the three agent cases dies without
touching the timeline switch.

### The SSOT shape

**File:** `packages/types/src/stream-rows.ts` (new), exported via the
`packages/types` barrel (INV-52).

**Type:** one exhaustive record — the exhaustiveness is the load-bearing
anti-drift device:

```ts
export interface RowSpec {
  rendersAsOwnRow: boolean
  grouping?: "command" | "session"
  authorGroupable: boolean // replaces MESSAGE_EVENT_TYPES
  patchesRow: boolean // → derives ZERO_HEIGHT_EVENT_TYPES
  broadcastSlot: boolean // → derives TIMELINE_BROADCAST_EVENT_TYPES (INV-61)
  hiddenInThread: boolean // replaces THREAD_HIDDEN_EVENT_TYPES
  conversationRef: "self-message" | "trigger-message" | "source-conversation" | "none"
  bumps: boolean // contract: only message_created is true
}
export const STREAM_ROW_SPEC: Record<EventType, RowSpec> = {
  /* one entry per EVENT_TYPE */
}
```

`Record<EventType, RowSpec>` means **adding a member to `EVENT_TYPES` is a compile
error until it declares how both views treat it.** That is the single change that
converts "drift by omission" into "won't build."

**Three orthogonal axes, promoted from prose to typed data** (this is the doc's
"rendering only: no assignment, no bump" at `board-view-design.md:684`, made
structural):

- _renders here_ = `rendersAsOwnRow || grouping != null` + `conversationRef != "none"`.
- _is a member_ = backend fact, single-sourced already (`conversation-assigner.ts`,
  `boundary-extraction-service.ts:595` — messages only). The spec does **not** own
  this; `conversationRef` is _render-side placement_, deliberately distinct from
  `conversations.message_ids`.
- _bumps_ = `bumps` field; enforced-false for every agent/memo/follow-up type.
  This is also the stable-view guard (§7).

### How both views consume it

- **Board** (the step-1 payoff): the rail reads spec-eligible types and filters
  with one predicate, `conversationKeyOf(row) === conversationId`, driven by
  `conversationRef`: `self-message`→`messageId`,
  `trigger-message`→`payload.triggerMessageId` (`agent-trace.ts:137`;
  `completed/failed/deleted` key off the session→trigger map the grouping already
  builds), `source-conversation`→`payload.conversationId`/`sourceConversationId`
  (`api.ts:1161,1178`), `none`→dropped. "X joined the channel" correctly never
  shows — as a _decision in the table_, not an accident.
- **Timeline** (later): `EventItem`'s switch and the scattered type-sets become
  spec lookups. Deferred to a separate PR.

### Exact current touch points eliminated

| Today (scattered)                                                                     | Becomes                                         |
| ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `MESSAGE_EVENT_TYPES` (`event-list.tsx:163`)                                          | derived `authorGroupable`                       |
| `ZERO_HEIGHT_EVENT_TYPES` (`event-list.tsx:304`)                                      | derived `patchesRow \|\| grouping`              |
| `THREAD_HIDDEN_EVENT_TYPES` (`stream-content.tsx:106`)                                | derived `hiddenInThread`                        |
| `TIMELINE_BROADCAST/COMMAND/AGENT_SESSION_EVENT_TYPES` (`constants.ts:120,141,485`)   | derived from spec (INV-31)                      |
| Board Dexie `message_created` filter (`use-board-card-messages.ts:127`)               | spec-eligible read + `conversationKeyOf` filter |
| `eventToRenderable` message-only projection (`:26`)                                   | shared `buildBoardRows`                         |
| `isContinuation` inline maps (`board-card.tsx:216,247`, `conversation-panel.tsx:343`) | one shared continuation pass                    |
| `EventItem` switch (`event-item.tsx:68`)                                              | `ROW_RENDERERS` lookup (deferred PR)            |

## 4. How the agent surfaces fall out (once the SSOT exists)

Each is a spec entry plus reuse of the existing row component — no new rendering,
no membership write, no bump:

- **Memory captures** — `{ rendersAsOwnRow:true, conversationRef:"source-conversation",
bumps:false }`. `payload.conversationId` (`api.ts:1161`) names the source
  conversation; the card renders the existing `MemoCapturedEvent`. Satisfies
  INV-62 on the surface people actually look at.
- **Reminders** — `{ rendersAsOwnRow:true, conversationRef:"source-conversation",
bumps:false }`. `sourceConversationId` (`api.ts:1178`) resolves it; reuse
  `FollowUpScheduledEvent` + the already-`export`ed `collectCancelledFollowUpIds`
  (`event-list.tsx:359`) so the Cancelled state is authoritative for every viewer.
  Closes the `caae3643` drift.
- **Agent traces** — `{ grouping:"session", conversationRef:"trigger-message",
bumps:false }`. Session grouping via the reused `getSessionSlotKey`
  (`event-list.tsx:93`); filtered to sessions whose _trigger message is a
  conversation member_. This **is** `board-view-design.md:678-684` verbatim — same
  "invoking message is a member," same `AgentSessionEvent`, "rendering only."

`bumps:false` on all three is what makes them render-only: they cannot move
`conversations.last_activity_at`, cannot perturb the stable view, cannot become
fake members. The doc's invariant is now enforced by a type field, not by
remembering.

The board's cross-stream reach already exists: `useMergedStreamRail` unions root +
child-thread streams (`use-board-card-messages.ts:192`, `useChildThreadStreamIds:283`),
so a session/memo/follow-up fired in a thread resolves to the root conversation
through the _same_ `conversationKeyOf`. No extra code for the nested case.

## 5. Sequenced PR plan (minimal-patch first, each shippable)

**PR 1 — Extract session-grouping helpers (pure refactor, tiny).**
New `apps/frontend/src/components/timeline/session-grouping.ts` exporting
`getSessionId`/`getTriggerMessageId`/`getSessionSlotKey` moved verbatim from
`event-list.tsx:83-95`; local copies **deleted** (INV-38/35). No behavior change.
Enables board reuse without duplicating trigger-slot logic. Trivially revertible.

**PR 2 — SSOT seam + agent activity on the board (the "step 1" that does both).**

- New `packages/types/src/stream-rows.ts`: exhaustive `STREAM_ROW_SPEC`.
  **Additive** — do not delete the literal arrays yet. Guard test: spec-derived
  sets `deepEqual` today's `TIMELINE_BROADCAST/COMMAND/AGENT_SESSION_EVENT_TYPES`
  (freezes behavior, proves the spec matches reality). Respects INV-31, INV-61
  (spec only _describes_ broadcast slots; write-side gating unchanged).
- New `apps/frontend/src/hooks/use-board-event-rows.ts`: ref-counted per-stream
  rail (mirrors the proven `subscribeStreamRail` pattern,
  `use-board-card-messages.ts:113-148`) over spec-eligible types via
  `[streamId+eventType].anyOf(...)`; unions the same stream set as the message
  rail. Separate file so the message rail is untouched and the feature is a clean
  revert.
- New `apps/frontend/src/components/board/conversation-event-rows.tsx`:
  `buildBoardRows` (interleave message + event rows by time, **reset the
  author-run on any interleaved non-message row** — the board analog of
  `annotateAuthorGroups`, `event-list.tsx:186`) + `<BoardRowItem>` dispatcher
  reusing `MessageItem`/`AgentSessionEvent`/`MemoCapturedEvent`/`FollowUpScheduledEvent`.
- Changed `board-card.tsx` + `conversation-panel.tsx`: feed `buildBoardRows(...)`
  → `<BoardRowItem>`; **delete** the two inline `isContinuation` maps.
- Tests (INV-39 real mount, INV-23 presence-not-counts): a card whose member
  message triggered a session / captured a memo / scheduled a follow-up renders
  that row; a session row resets a same-author run.
- Closes drift symptoms 1–3. Board route already sits under `TraceProvider`
  (`workspace-layout.tsx:463`), so `AgentSessionEvent`'s `useTrace()` resolves
  with no wiring. INV-51/52/29/43 respected (variant config in the spec table; one
  shared render path).

**PR 3 — Collapse the scattered arrays into the spec (derive + delete, no behavior
change).**
Re-derive `TIMELINE_BROADCAST/COMMAND/AGENT_SESSION_EVENT_TYPES` (`constants.ts`),
`MESSAGE_/ZERO_HEIGHT_/THREAD_HIDDEN_EVENT_TYPES` (`event-list.tsx`,
`stream-content.tsx`) from `STREAM_ROW_SPEC`; **delete** the literals (INV-38).
PR 2's guard test guarantees identical values. Backend broadcast gating reads the
derived set. This is where the timeline's _implicit_ registry becomes explicit.

**PR 4 — Migrate the timeline switch onto the registry (deferred).**
New `components/timeline/stream-rows/registry.tsx` (`ROW_RENDERERS` keyed by
row-kind); `EventItem` switch → lookup. Now a new event type = one spec entry +
one renderer entry, _both views by construction_. Larger, independently
revertible, not required for the agent fix.

**PR 5 — Live session step-counts on the board.**
Mount `useAgentActivity` (`use-agent-activity.ts:65`) for the card's
already-subscribed streams so the session card shows live counts, not just
persisted lifecycle. Closes the "0 steps until complete" degradation PR 2 ships
with.

**Not bundled — separate backend correctness follow-ups** (§7): move-message
one-root membership strip; delivery-groups workspace promotion for agent events;
`conversation-item.tsx` INV-60 strip.

## 6. Relationship to the doc (and divergences the maps found)

- **"Agents on the board" (next-up #2, `board-view-design.md:840-842`):** PR 2
  _is_ this item, delivered as a spec entry rather than bespoke board plumbing.
  The doc frames it as a small addition; the code shows **zero board-side
  scaffolding** (`useBoardCardMessages` is type-keyed to `message_created`), so
  the honest cost is a rail + a shared dispatcher — which the SSOT amortizes across
  all future types instead of paying per-feature.
- **"Nested threads × conversations":** the SSOT makes this _cheaper_.
  `conversationRef` + the existing root+thread rail union (`useMergedStreamRail`)
  means a thread-fired event resolves to the root conversation through one
  predicate — no per-type cross-stream logic.
- **Doc/code divergences to log (not fix here):**
  1. `useStreamRail` (`board-view-design.md:579`) **does not exist**; the real
     construct is `subscribeStreamRail`/`useMergedStreamRail` in
     `use-board-card-messages.ts` — and it's `message_created`-only, structurally
     the root of the drift.
  2. Move-message one-root membership strip (`:644-645`) guards an operation that
     **doesn't exist yet** — `moveMessagesToThread` (`event-service.ts:1068`) is
     same-root by construction and never touches `conversations`. Aspirational,
     not a live bug; becomes live only if a real cross-root move ships.
  3. Delivery-groups asymmetry: `conversation:created/updated` get a
     `WORKSPACE_GROUP` promotion (`delivery-groups.ts:198-214`);
     `agent_session:*`/`memos:captured`/follow-up events do **not**. On-screen
     cards are covered by `useBoardStreamSubscriptions` joining rooms; the residual
     exposure is a never-opened public channel lagging agent activity until next
     catch-up. Undocumented in the doc's "Agents on the board" section.
  4. Superseded "Architecture sketch" reuse claim (`:208`): the shipped board
     (`BoardCard`/`useBoardCardMessages`) does **not** reuse
     `conversation-item.tsx`/`conversation-list.tsx`; those are leftover,
     still-mounted, and `MessagePreview` (`conversation-item.tsx:189`) renders raw
     `contentMarkdown.slice(0,200)` in a plain `<p>` — an **INV-60 violation**
     (unstripped markdown). Flag for separate cleanup.

## 7. Scope guard & risks

**Do NOT (INV-36 / scope):**

- **Merge `MessageItem` and `MessageEvent`.** They're two independent components
  with hand-rolled action contexts and real drift (`MessageEvent` has
  `ACTOR_ROW_THEME` persona/bot theming, `MessageItem` has none). The SSOT lets
  `ROW_RENDERERS.message` resolve per-surface later; forcing the merge now is a
  large unrelated change. Honest cost: a persona's gold stripe still won't show on
  a board reply until that separate PR.
- **Touch backend membership/bump/delivery-groups in the render PRs.** All three
  follow-ups above are orthogonal correctness issues; on-screen cards already get
  live agent events via room joins.
- **Port live step-tickers in PR 2.** `AgentSessionEvent` degrades gracefully to
  "working…/complete • N steps" without `useAgentActivity`
  (`agent-session-event.tsx:184`). Ship that; add live counts in PR 5.
- **Big-bang the timeline switch (PR 4) before PR 2 ships value.** The agent drift
  dies without it.

**INV-61 / stable-view risks:**

- The board is a _resurfacing projection_ sorted by `sortMs`, **not** by
  `broadcastSequence`. It must never inject gaps or read the contiguity path.
  Guard: `buildBoardRows` emits no `gap`/`skeleton` rows; a test asserts it.
  INV-61 stays strictly timeline-side.
- Stable view (`use-stable-board-view.ts:72-107`) freezes _card set and order_;
  the row model lives strictly _below_ the card boundary and changes only card
  _content_ — which the model already treats as live. `bumps:false` on every
  agent/memo/follow-up type means `last_activity_at` can't move, so the frozen
  grouping key can't be perturbed. The type field that enforces INV-62 also
  protects the stable view.

**The one thing most likely to go wrong:** the _continuation reset on an
interleaved row_. The board's `isContinuation` (`message-item.tsx:92`) has never
had to break a same-author run on a non-message row because its array was
homogeneous by construction. Get this wrong and a reply after a session card
silently mis-groups (loses/gains a header). It's the single piece of genuinely new
logic — it must have a dedicated mount test in PR 2. Everything else is reuse.

**Where to start:** PR 1 is a 3-symbol mechanical extraction — open it now. PR 2
builds the spec against confirmed payload fields (`agent-trace.ts:137`,
`api.ts:1161`, `api.ts:1178`) and the existing components.

## Verification

Load-bearing claims re-checked by hand against the working tree (2026-07-04):

- Board rail Dexie filter is `message_created`-only —
  `use-board-card-messages.ts:127` ✓
- Zero non-test `eventType` references under `components/board/` and in
  `conversation-panel.tsx` ✓
- `MemosCapturedEventPayload.conversationId` (`api.ts:1161`), follow-up
  `sourceConversationId` (`api.ts:1178`, `domain.ts:737`), agent-trace
  `triggerMessageId` (`agent-trace.ts:137`) all exist — the "falls out for free"
  resolution is grounded ✓
- `caae3643` `--stat` touched only timeline files, no board/panel/use-board edits ✓
