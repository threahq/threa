# Event-Anchored Threads

Threads rooted on timeline events (cards), not only on messages. v2 (2026-07-21), exploration on branch `explore/anchor-threads-non-message-events`.

v1 proposed `parent_event_id` XOR `parent_message_id` (two kind-specific columns). Kris rejected the two parallel tracks as drift-prone; v2 unifies onto ONE anchor track everywhere, with a short grace period for legacy shapes then removal — "better we unify now since we barely have any users to affect."

## Problem

Threads can only anchor on a message: `streams.parent_message_id` is validated against a real message in `StreamService.createThreadOn` (`apps/backend/src/features/streams/service.ts:650-653`) and made idempotent by the partial unique index `idx_streams_thread_parent (parent_stream_id, parent_message_id)`. Two shipped features already wanted a thread under a non-message card and each worked around it differently:

- **Delegations** (F1, #1334): `completeDelegation` posts a synthetic anchor message (`✓ Completed: **<title>**. Result in thread.`), creates a thread on it, and posts the result inside (`public-api/delegation-handlers.ts:295-348`). The card and the anchor message are two timeline rows saying the same thing.
- **Calls** (#1410–#1424): the call card has no discussion surface at all. `calls.chat_stream_id` was reserved (`20260719120000_calls.sql:27`, "lazily created call-chat stream (later PR)") for a linked stream _presented_ as docked to the card — a second workaround shape.

Recorded as a deferred primitive in the calls plan (§Deferred, [seer](https://seer.build/b/voice-video-calls-plan-026e89/)): "threads rooted on timeline events", with the instruction to reconcile the two interim shapes into one. Original delegation ask: "reply-to-non-message-events, data-plane, tread lightly."

Future consumers once the primitive exists: `memos:captured` rows (discuss a capture), agent-session cards, `agent:follow_up_scheduled` cards.

## Current model (what the primitive must generalize)

- A thread is a `streams` row: `type='thread'`, `parent_stream_id`, `parent_message_id`, `root_stream_id` (non-thread ancestor; access/visibility/memory/E2E all inherit through it — INV-62).
- A message is one event type among ~31 in `stream_events`; cards (`delegation:created`, `call_started`, `memos:captured`, …) are broadcast events with their own dense `broadcast_sequence` slot (INV-61); transitions arrive as slot-less patch events (`call_ended`, `delegation:status_changed`).
- `STREAM_ROW_SPEC` (`packages/types/src/stream-rows.ts`) is the per-event-type anti-drift registry describing how each type participates in timeline + board.
- Thread creation emits NO timeline row (`thread_created` is legacy/no-longer-emitted). The "thread exists" signal is a projection: `messages.reply_count` + `threadSummary` healed onto the anchor message via bootstrap `threadStates` and live `message:updated {updateType: "reply_count"}` patches.
- Thread affordance (ThreadSlot chip, reply-in-thread, draft panel `draft:<parentStreamId>:<parentMessageId>`) is wired only in `MessageEvent`; every non-message card is a leaf renderer with zero thread wiring.

## Design

### Anchor: one column, `parent_anchor_id` — the timeline item's canonical id

`streams.parent_anchor_id TEXT`: `msg_…` when the anchor is a message, `event_…` when it is a card. One value, one semantic — "the canonical id of the timeline item this thread hangs under" — discriminated by ULID prefix (INV-2; the exact pattern `?m=` deep-links already use: prefix-routed in `getEventsAround`, matched by `matchesDeepLinkTarget` since #1269).

- **Why canonical ids and not event ids for everything**: a moved message keeps its `msg_` id but its event row is tombstoned/re-created (`messages:moved`), so message threads anchored by event id would break on move. Cards never move. Anchoring each item by ITS canonical id sidesteps instability entirely while keeping message-keyed lookups (`findThreadsForMessageIds`, reply stamping) direct.
- **Why not the domain entity** (`call_x`/`dlg_x`): the event row IS the card — stream-scoped, deep-linkable, one lookup path for all kinds; entity anchoring would need per-feature resolution to find the renderable card.
- Idempotency: ONE partial unique index `idx_streams_thread_anchor (parent_stream_id, parent_anchor_id) WHERE parent_anchor_id IS NOT NULL`; `insertThreadOrFind` targets it. `parent_message_id` and its index live only through the grace period (§Migration).

### Threadability is registry-driven

`StreamRowSpec` gains `threadable: boolean`. v1 true set: `message_created` (status quo), `delegation:created`, `call_started`. Everything else false (patches, commands, grouped session events, membership chrome). `THREAD_ANCHORABLE_EVENT_TYPES` derives from the spec (same pattern as `BOARD_EVENT_ROW_TYPES`); `createThreadOn` rejects non-threadable anchor types. Turning on a future card (memos:captured) = flip the flag + give its renderer the affordance.

### Creation path

`createThreadOn(params: { parentStreamId, parentAnchorId, … })` — one signature. Anchor validation prefix-routes: `msg_` → `MessageRepository.findById` + same-stream assert (status quo); `event_` → `StreamEventRepository` lookup + same-stream assert + threadable check. Everything after validation is already anchor-agnostic: root derivation, visibility/companion/memoryMode inheritance, E2E propagation (all keyed off the parent stream), `stream:created` to the parent room. Membership: creator + anchor actor (message author / event `actor_id` when `actor_type='user'`).

Internal API: `createStreamSchema` takes `parentAnchorId` for `type=thread`; `parentMessageId` accepted as an alias during grace (normalized at the handler), then removed. Scheduled messages' `parent_message_id` column already holds a `msg_` id — treated as an anchor id semantically, renamed in cleanup.

### Projections: one patch event, stats live on the thread row

**`thread:updated` replaces `message:updated {updateType:"reply_count"}` for ALL anchors immediately** (Kris's call). Outbox-published to the parent stream, no timeline row, no broadcast slot (same class as `call:participants_changed`): `thread:updated { parentStreamId, anchorId, threadId, replyCount, threadSummary }`. During grace the legacy `message:updated` reply_count patch is dual-emitted for old bundles (the pages-before-Railway window — persisted/wire shapes must tolerate one deploy of skew), then deleted.

**Reply stats move to the thread stream row**: `streams.reply_count` (+ `last_reply_at`), maintained by `EventService` at the existing four mutation sites (create/delete/move-in/move-out) — simpler than today's writes, since the thread IS the stream the reply landed in (no parent-message lookup; atomic increments, INV-20). `messages.reply_count` becomes a grace-period shadow: dual-written, then unwritten, then dropped. Wire `replyCount` on messages derives via join on `parent_anchor_id` (indexed, cheap) — public message schema unchanged.

- **Bootstrap**: `threadStates` entries become `{ anchorId, threadId, replyCount, threadSummary }` — one shape; `parentMessageId` rides alongside during grace, then removed. Computed by the same batch queries, now reading `streams.reply_count` instead of counting.
- **ThreadSummary** (participants, latestReply) stays computed at read (display sugar, not worth a projection).
- **Boundary extraction**: `threadRootIds` (today "messages with replyCount>0") switches to "anchor ids of threads with replyCount>0" — one query against `streams`, message- and event-anchored alike.

INV-61: no new timeline row anywhere; contiguity untouched.

### Frontend: anchor-keyed, one track

- **Keys**: draft panel ids (`draft:<parentStreamId>:<anchorId>`), `threadStates` maps, sync healing, `threadsByParentMessageId` → `threadsByAnchorId`, draft scopes `thread:{anchorId}` — all one opaque anchor id. Message threads keep byte-identical keys (same `msg_` id), so persisted drafts/scopes migrate by construction.
- **Healing**: `applyBootstrapThreadStates`/socket handlers locate the timeline item by canonical id — the `matchesDeepLinkTarget` predicate is exactly this lookup; reuse it. Healed `threadSummary` lands on the item's payload regardless of kind.
- **Thread root render**: `stream-panel.tsx:610` / `stream-content.tsx:2499` generalize `<ThreadParentMessage>` → `<ThreadParentEvent>`: find the anchor item by canonical id (parent-stream cache, else `events/around`, which takes both prefixes), render through the existing `EventItem` dispatcher — cards are already self-contained payload renderers. Known limitation (pre-existing for cards generally): patch state (`delegation:status_changed`, `call_ended`) outside the fetched window renders the card pre-patch; acceptable, the parent timeline is authoritative.
- **Affordance**: extract ThreadSlot/reply-chip + `replyUrl` wiring from `MessageEvent` into a shared piece; threadable cards (DelegationEvent, CallCard) opt in. Placement per card (footer chip, "Discuss" action).
- **Deep links/notifications**: `?m=<anchorId>` already works end-to-end. Notification suppression unchanged. "Replied on your delegation" attribution falls out of membership (anchor actor is a member).
- **Sidebar**: thread rows already render root-context labels via `rootStreamId`; nothing keys on the anchor there. Bonus: `streams.reply_count` gives sidebar/quick-switcher thread rows a count for free.

### How far the unification goes (and the honest residue)

Unified to one track: anchor column + unique index, creation signature, bootstrap shape, live patch event, stats storage, boundary extraction, draft/panel/scope keys, healing lookup, deep links, `findThreadRoot` (returns the anchor item; prompt serialization per kind inside the one helper).

Legitimate per-kind branches that remain — each a dispatch that already exists, not a parallel track:

1. **Anchor validation** at creation (which table proves existence) — one prefix-route in `createThreadOn`.
2. **Rendering** — the `EventItem` per-type dispatcher (messages render as messages, cards as cards); no new branching added.
3. **Wire compat** — public `messageSchema.replyCount`/`threadStreamId` stay (derived); events aren't public wire entities, so event-anchored threads surface publicly only as thread streams with `anchorId`.
4. **`messages:moved` re-link** — message-only by nature (cards don't move); dormant branch at the move site.

### Board: deferred (Kris pre-approved)

Board cards are conversations (`message_ids[]`); branches key off `forkMessageId`. `call_started` is `conversationRef:"none"` (never on the board); `delegation:created` projects via `source-conversation` and its thread could eventually render as a branch on that card — needs an anchor-aware branch model, deferred. An event-anchored thread is reachable from the timeline card and the sidebar meanwhile.

### Consumer 1: delegations (retire the hack)

`completeDelegation` stops posting the anchor message. Same single transaction: thread = `createThreadOn(parentAnchorId: createdEventId)` (already queryable — `GET /delegations` LEFT JOINs for `createdEventId` since #1269), result message posted inside, `result_message_id` = the result message (not the anchor). Card's "View result" → opens the thread panel. `delegation:status_changed` payload gains `threadStreamId` so the card renders its thread chip zero-fetch.

**Grandfathering**: existing completed delegations keep their anchor-message threads — they are ordinary message-anchored threads and render correctly forever; no backfill. `markDone` stays thread-less.

### Consumer 2: calls (the chat becomes the thread)

The call chat = a thread anchored on the `call_started` event. Created lazily on first chat open/message via `insertThreadOrFind` (race-safe on the anchor index); v1 resolves the association through anchor propagation and lookup without writing `calls.chat_stream_id`.

- Access: plain `root_stream_id` inheritance — v1 calls require host-stream access (calls plan v5/v7 ruling: zero `access.ts` changes), so thread inheritance is exactly right. The deferred guest primitive composes later.
- During-call: dock/expanded call UI opens the thread panel (existing panel machinery); members discuss live.
- After: the card's thread chip carries the discussion; the deferred transcription follow-up posts the call summary INTO this thread — its persistent home. `memoryMode` inherits from root (chat = v1's only call knowledge, consistent with the plan's ON ruling).

### Public API: mint the first dated version

With the unified model the reshape is honest, so this becomes the first real `VERSION_CHANGES` entry (exercising the evergreen-docs machinery end to end):

- New version `2026-XX-XX`: `streamSchema` gains `anchorId` (prefix-discriminated; kind derivable) and drops `parentMessageId`.
- `downgradeResponse` for older pins: `anchorId` starting `msg_` → emit `parentMessageId`; event anchors omit the field (older clients couldn't use it anyway). Total for every thread that existed before the feature.
- `downgradeSpec` mirrors it for the per-version OpenAPI (`generate-api-docs.ts` → `docs/public-api/versions/*.json`, public-site `/openapi/<version>.json`, CHANGELOG).
- `messageSchema` unchanged (`replyCount` now derived server-side; `threadStreamId` as today). No public thread-creation endpoint exists, so no request transform needed.
- CLI/MCP: keys off `rootStreamId`, unaffected; stream output gains `anchorId`.

## Migration & grace period

Phase 1 (the feature stack, one deploy):

1. Migration: add `streams.parent_anchor_id`, `streams.reply_count`, `streams.last_reply_at`; backfill `parent_anchor_id = parent_message_id`, `reply_count` from the existing per-thread counts; add the anchor unique index. Append-only (INV-17); no queued backfill needed (single UPDATE over thread rows — small table), INV-67 not triggered.
2. Code dual-writes both columns (`parent_anchor_id` + legacy `parent_message_id` when `msg_`), dual-emits `thread:updated` + legacy reply_count patch, dual-maintains `streams.reply_count` + `messages.reply_count`. Old-deploy replicas writing only the legacy column stay correct during the window: new code reads `COALESCE(parent_anchor_id, parent_message_id)`.
3. Frontend consumes the new shapes, tolerates the old for one deploy of skew (pages-before-Railway window).

Phase 2 (cleanup PR after a short grace, ~1–2 weeks): stop legacy writes/emissions, remove alias acceptance + frontend legacy handlers, switch boundary extraction, then a final append-only migration drops `parent_message_id`, its index, and `messages.reply_count`.

## PR stack sketch

1. **Substrate**: migration + backfill + `Stream.anchorId` types + `threadable` in `STREAM_ROW_SPEC` + `createThreadOn` anchor routing + `insertThreadOrFind` on the new index + handler alias + dual-writes + tests (INV-62 non-member-thread case, prefix validation, idempotent double-create race, dual-write consistency).
2. **Projections + sync**: `thread:updated` (dual-emitted) + `streams.reply_count` maintenance + bootstrap `threadStates` reshape + frontend healing via canonical-id lookup.
3. **Thread UI substrate**: draft/panel/scope anchor generalization + `<ThreadParentEvent>` via EventItem dispatch + shared thread-affordance extraction.
4. **Delegation cutover**: card affordance + `completeDelegation` re-anchor + `threadStreamId` in status payload.
5. **Call chat**: lazy thread on `call_started` + anchor propagation/lookup + dock chat surface.
6. **Public API version**: first `VERSION_CHANGES` entry + docs regen + public-site per-version spec.
7. **Cleanup (post-grace)**: legacy removal + drop migration.

1–3 sequential substrate; 4 and 5 parallel consumers; 6 anytime after 1; 7 after grace.

## Decisions (Kris, 2026-07-22 — plan fully ratified)

1. Call chat creation: **lazy**, like other threads.
2. v1 additions to the threadable set: **`delegation:created` + `call_started`**; `message_created` remains threadable.
3. Grace: **cleanup ships as a PR immediately after the stack; Kris merges it when he pleases** (no fixed window).

Resolved earlier in discussion: unified single anchor column (not XOR columns); `thread:updated` for all anchors immediately with legacy dual-emit then removal; mint the first dated public-API version.
