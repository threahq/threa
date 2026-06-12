# Sync v2 PR E+ — healing-path inventory and deletion verdicts

Survey of every remaining client-side healing path (blanket reconnect
invalidations, bootstrap refetches, INV-53 redundancy) now that the workspace
sync cursor is the default (`sync-v2-cursor: active`, #884) and the
saved/scheduled reconnect refetch is gated (#885). Ground rules carried from
the rollout sessions:

- **One healing deletion per PR**, each with a test proving the cursor covers
  what the deleted healing covered.
- **Never delete healing that covers dropped live emits** until a socket
  heartbeat exists.
- Coverage proof method (established in #885): event type → scoping list in
  `apps/backend/src/lib/outbox/repository.ts` → delivery group
  (`delivery-groups.ts`, single source of truth for log + emit) → `sync_log`
  (`features/sync/repository.ts:listEntriesForUser`) → `gate.dispatch` through
  the registered live handlers.

## Two mechanics that decide every verdict

**1. The log is populated independently of emit success.** The
BroadcastHandler persists delivery groups to `sync_log` and derives the
Socket.io rooms from the same groups, so a dropped live emit still has a log
entry, the client cursor stays behind it (the cursor only advances by applied
events), and the _next_ catch-up trigger (reconnect, resume, online flip)
replays it. What's missing is _detection between the drop and the next
trigger_ — that's the heartbeat gap. Consequence: healing that fires on the
same triggers as catch-up adds no dropped-emit coverage; only healing with
_extra_ triggers (or continuous detection, like timeline contiguity) does.

**2. Catch-up replay reaches only gate-registered handlers.**
`SocketEventGate.dispatch` invokes handlers registered _on the gate_
(`sync-engine.ts:getLiveEventSource`). Registered on the gate today:
`registerWorkspaceSocketHandlers` (workspace-sync), engine-owned
`registerStreamSocketHandlers` per member stream (stream-sync), and
`useStreamSocket`, and (since the additive PR) `use-conversations`. Registered
on the **raw socket** (replay never reaches them): `use-agent-activity`,
`use-agent-trace`, `use-link-preview-dismissals`, `use-voice-dictation` — all
ephemeral-event consumers except `use-link-preview-dismissals` (logged,
author-scoped; migrate if dismissal staleness is ever reported).

## Decision (2026-06-12): additive first

The rollout isn't complete (no heartbeat, no sync_log retention), so the owner
chose to finish wiring consumers into the sync system before deleting any more
healing. PR E therefore ships the **additive** halves only:

- `use-conversations` registers through the engine's event gate (catch-up
  replay now reaches it); its reconnect invalidation **stays**.
- `memo:created` gets a gate-registered handler in workspace-sync (it was
  logged but had no listener at all) — memos now ride the system.

The deletions below follow afterwards, one per PR as before. The
`usePageResumeRefresh` redesign is agreed as a follow-up: once retention ships
and the resume path no longer needs the blanket bootstrap fetch, resume becomes
"cursor catch-up only" and the 5s hook is deleted rather than redesigned.

## Deletion candidates (in agreed order, after the additive PR)

### `use-conversations` reconnect invalidation — DONE

`apps/frontend/src/hooks/use-conversations.ts`: invalidated the conversation
list on every socket reconnect. **Gated on active mode** (the deletion PR
following #891): the invalidation now skips when
`syncEngine?.syncCursorMode === "active"`.

- All four conversation events are stream-scoped in the log
  (`conversation:created`/`updated`/`message_assigned` also fan out to the
  parent stream group), and `listEntriesForUser` returns them for member
  streams including threads (INV-62 rule mirrored in the SQL).
- ~~Blocker:~~ **done in the additive PR (#891)** — the hook registers through
  `syncEngine?.getLiveEventSource() ?? socket` (the `useStreamSocket` pattern),
  so replay reaches it.
- Unmounted-during-catch-up is safe: the query uses default staleness, so the
  next mount refetches anyway. The invalidation only ever fired on reconnect,
  so dropped-emit coverage is unchanged.
- Tests pin: gate-dispatched replay updates the list cache in active mode with
  no invalidation; `off`/`shadow`/no-engine keep the invalidation.

**Verdict: covered; deleted.**

### `refetchOnReconnect: true` on saved + scheduled lists

`use-saved.ts:150`, `use-scheduled.ts:203`. Kept by #885 to cover the pure
browser online/offline flip (no socket.io reconnect cycle).

- The same flip already triggers `refreshAfterConnectivityResume()`
  (workspace-layout.tsx isOnline effect) → `runCatchUp("resume")` → replays
  the user-scoped saved/scheduled entries through the gate-registered
  workspace-sync handlers — the exact PR-B proof chain, on the exact same
  trigger.
- Needs the hooks to read the engine mode (engine context) to set the option
  per mode; keep `true` in off/shadow.

**Verdict: covered in active mode. Same shape and risk profile as #885.**

### `refetchOnReconnect: true` on `useLabelsSync`

`use-labels.ts:194`. All seven `label:*` events have delivery groups and
gate-registered handlers in workspace-sync, so the reconnect gap is replayed
in active mode.

- **One open edge:** public-label `label:assigned`/`unassigned` on a _stream_
  resource is stream-group-scoped. Catch-up only returns stream groups for
  member streams, but a non-member can be viewing a public stream live (live
  emit reaches the room; catch-up won't return it). The labels query has
  `staleTime: Infinity`, so without `refetchOnReconnect` that viewer's
  assignment state stays stale until a reload or another invalidation.

**Verdict: mostly covered; resolve or accept the non-member public-stream
edge before deleting.**

## Not deletable / keep as-is

- **`usePageResumeRefresh`** (workspace + visible-stream bootstrap
  invalidation on ≥5s resume): overlaps `SyncEngine.handlePageResume` (≥10s
  away → probe → full reconnect bootstrap + catch-up), and on a ≥10s resume
  the two run _duplicate_ full bootstrap fetches in every mode — but it is the
  only healing in the 5–10s window and the only blanket cover for
  "socket-healthy but tab-throttled" gaps below the probe threshold. Any
  change here is a redesign (threshold alignment / engine-owned resume
  catch-up), not a one-line deletion. Owner decision; not next.
- **Engine reconnect workspace bootstrap** (`runBootstrap(true)`): blocked.
  Bootstrap is still the authority for legacy unread-counter entries (until
  `sync_log` retention ships and `isLegacyUnreadCounterEntry` dies), heals the
  accepted #874 drift, and active-mode seeding is read-before-stamp against
  this very fetch.
- **Per-stream reconnect delta** (`joinStreamForCatchUp` + `bootstrap?after=`):
  this _is_ the per-stream cursor mechanism, already delta-shaped. Keep.
- **`backfillStreamGap` / `detectSequenceGap` / `computeTimelineHoles`**
  (INV-61): the only healing with in-band dropped-emit _detection_ (a gap is
  visible the moment the next event arrives). Keep until a heartbeat exists.
- **Ephemeral raw-socket handlers** (`agent_session:activity_started`,
  `:progress`, `:step:*`, voice, `bot_runtime:presence`,
  `pointer:invalidated`): not outbox-routed, never in the log; no healing
  attached. Nothing to do. (`agent_session:started/completed/failed/deleted`
  _are_ logged and replay through gate-registered stream-sync handlers.)
- **`use-memos`**: `memo:created` was workspace-group-logged but had no
  frontend listener at all — fixed in the additive PR with a gate-registered
  handler in workspace-sync that invalidates the memory-explorer search
  queries, so live emits and catch-up replays both heal it now. In-situ
  capture rides `stream:memos_captured` through stream-sync.
- **`refetchOnMount: true`** on saved/scheduled/labels/activity: mount-time
  freshness, not reconnect healing. Out of scope.
- **`useBackgroundBootstrapSync`** (SW prefetch) and **`useAppUpdate`**
  (version check on reconnect): not sync healing.
