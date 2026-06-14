# Sync v2 PR E+ — healing-path inventory and deletion verdicts

> **Update (flag retired).** The `sync-v2-cursor` feature flag has since been
> deleted and active mode hardwired: the `SyncEngine` always runs the cursor
> when a sync service is wired. The `off`/`shadow` paths and the per-flag mode
> branching are gone, so the gates described below as "active mode" /
> "`syncCursorMode === "active"`" are now simply "a `SyncEngine` is mounted"
> (engine present). The healing verdicts are unchanged; only the predicate
> simplified. Entries below are kept as the historical record of each PR.

Survey of every remaining client-side healing path (blanket reconnect
invalidations, bootstrap refetches, INV-53 redundancy) now that the workspace
sync cursor is the default (`sync-v2-cursor: active`, #884) and the
saved/scheduled reconnect refetch is gated (#885). Ground rules carried from
the rollout sessions:

- **One healing deletion per PR**, each with a test proving the cursor covers
  what the deleted healing covered.
- **Never delete healing that covers dropped live emits** until a socket
  heartbeat exists. _The heartbeat now exists_
  (`docs/plans/sync-v2-heartbeat.md`): the server broadcasts each workspace's
  sync-log head every 15s and active-mode clients trigger catch-up when
  behind, bounding dropped-emit detection to ~interval+grace. Deletions it
  gates are unblocked on this axis. _sync_log retention now exists too_
  (`docs/plans/sync-v2-log-retention.md`): the worker prunes entries past a
  30-day horizon (keeping a per-workspace recent floor) and catch-up returns
  `requiresBootstrap` for cursors below the pruned floor, so the big deletions
  (reconnect-bootstrap slimming, `usePageResumeRefresh`) lose their retention
  blocker — they still each ship as their own PR with a coverage proof.
  `isLegacyUnreadCounterEntry` died in two steps (both DONE): a one-time
  content-based sweep migration (`20260613083239_prune_legacy_counter_entries.sql`)
  removed the legacy entries the guard skips — by content, not a hardcoded
  boundary, because pure time+count retention leaves a quiet workspace's legacy
  rows in place indefinitely (its history never exceeds the `minKeep` floor) —
  and then, once the sweep deployed to prod (verified by a read-only prod check:
  zero legacy counter entries remained), a follow-up PR deleted the guard and its
  sync-engine call sites.
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

The rollout wasn't complete at decision time (no heartbeat, no sync_log
retention — both have since shipped, see the ground rules above), so the owner
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

### `refetchOnReconnect: true` on saved + scheduled lists — DONE

`use-saved.ts:useSavedList`, `use-scheduled.ts:useScheduledList`. Kept by #885
to cover the pure browser online/offline flip (no socket.io reconnect cycle).
**Gated on active mode (#900):** both hooks read the engine via
`useOptionalSyncEngine()` and set
`refetchOnReconnect: syncEngine?.syncCursorMode !== "active"` (null engine →
`true`), so off/shadow/no-engine mounts keep the refetch.

- The same flip already triggers `refreshAfterConnectivityResume()`
  (workspace-layout.tsx isOnline effect) → `runCatchUp("resume")` → replays
  the user-scoped saved/scheduled entries through the gate-registered
  workspace-sync handlers — the exact PR-B proof chain, on the exact same
  trigger.
- Tests pin the mode matrix (an invalidated-while-offline query refetches on
  the flip in off/shadow/no-engine, not in active) and the replacement path
  (`gate.dispatch("saved:upserted"/"scheduled_message:upserted")` lands rows
  in IDB).

**Verdict: covered; gated (#900).**

### `refetchOnReconnect: true` on `useLabelsSync` — DONE

`use-labels.ts`. All seven `label:*` events have delivery groups and
gate-registered handlers in workspace-sync, so the reconnect gap is replayed
in active mode. **Removed outright (explicit `refetchOnReconnect: false`, not
mode-gated — owner decision)** after investigation showed the flag was inert
in every mode:

- With `staleTime: Infinity`, `refetchOnReconnect: true` only fires on the
  online flip for an invalidated query (mechanic 3 below), and the only
  invalidators of `labelKeys.list` are the label mutation hooks themselves —
  which cannot run while offline. The flag could never fire, in any mode.
- The non-member public-stream edge flagged earlier is real for catch-up
  (`listEntriesForUser` builds `visible_streams` from `stream_members` only,
  so a stream-group-scoped public `label:assigned` never replays to a
  non-member viewing the public stream) — but it is already healed by a kept
  mechanism: the engine's reconnect workspace bootstrap fetches
  `labelAssignmentService.listForViewer` (public rows gated through
  `listAccessibleStreamIds`, which includes non-member public streams per
  INV-62) and the frontend reconciles labels/memberships/assignments into IDB
  (bulkPut + stale-delete). IDB is the render source; the `useLabelsSync`
  query data is only read for `isFetched`.
- The hook mounts only on the labels catalog and label-detail pages, so there
  was no workspace-wide query for the flag to heal in the first place.
- Tests pin both sides: the hook does not refetch on the online flip even
  when invalidated while offline, and a gate-dispatched
  `label:assigned`/`unassigned` replay lands/removes the assignment row in
  IDB.

**Verdict: inert healing; deleted. The catch-up gap for non-member public
streams is owned by the reconnect bootstrap reconcile (kept, see below).**

### Mechanic 3 (added with the labels deletion): when `refetchOnReconnect` can fire

TanStack v5 (5.99.0, verified in source): on the online flip,
`shouldFetchOnReconnect` → `shouldFetchOn` → `isStale` → `query.isStaleByTime`
(`shouldFetchOn` also returns false outright for `staleTime: "static"`). With
`staleTime: Infinity` and data present, `isStaleByTime` is true only when
`state.isInvalidated` — and a fetch success resets `isInvalidated`. So for an
Infinity-staleTime query, `refetchOnReconnect: true` is only live if something
invalidates the query while offline. Audit that invalidator set before
treating such a flag as real healing — it may be dead code (labels was).

## Not deletable / keep as-is

- **`usePageResumeRefresh`** (workspace + visible-stream bootstrap invalidation
  on ≥5s resume): **deleted; resume is now engine-owned (#917).** It overlapped
  `SyncEngine.handlePageResume` and on a ≥10s resume the two ran _duplicate_
  full bootstrap fetches — the only thing it covered alone was the 5–10s window
  below the old probe threshold. #917 unified the trigger at a single 5s
  `PAGE_RESUME_THRESHOLD_MS` (one engine-owned entry point covers the whole
  window, including the former 5–10s gap) and slimmed
  `refreshAfterConnectivityResume` to `runBootstrap(true)` — so an active-mode
  resume / online flip now runs `slimReconnectBootstrap()` + `runCatchUp("resume")`
  instead of a full snapshot, the same slim path the socket reconnect uses. The
  engine already tracks the identical visible-stream set the hook computed
  (`currentStreamId` + `visibleStreamIds`), so per-stream deltas cover what the
  hook's `streamKeys.bootstrap` invalidations did. Full snapshot still kept for
  off/shadow/cold-connect and the below-floor `requiresBootstrap` fallback.
- **Engine reconnect workspace bootstrap** (`runBootstrap(true)`): **slimmed for
  the active-mode socket reconnect (DONE).** The full-snapshot fetch was
  redundant there — catch-up replay (which runs right after) re-seeds every
  workspace-scoped projection through the gate-registered handlers, patching
  both IDB and the TanStack bootstrap cache exactly as live events do. On an
  active-mode reconnect the engine now runs `slimReconnectBootstrap()` instead:
  per-stream message deltas (the per-stream cursor mechanism, unchanged), a
  `reconcileViewerLabels()` reconcile (`labelService.list` → `reconcileLabels` —
  the one slice catch-up can't carry, assignments on public streams the viewer
  can see per INV-62 but isn't a `stream_members` row for), and member-room
  re-subscription from the cached membership list. The full snapshot is kept
  for: the first connect (cold load), off/shadow modes, a missing `labelService`
  (defensive fallback), the **resume / online-flip path**
  (`refreshAfterConnectivityResume` passes `forceFull: true` — that window is
  the `usePageResumeRefresh` follow-up's territory, see below), and the
  **below-floor `requiresBootstrap` fallback** (also `forceFull: true` — a
  cursor below the retained floor has no log to replay, so only the full
  snapshot is authoritative for everything `<= head`; `forceFull` upgrades an
  already-queued slim reconnect so it can't be collapsed away). Static
  bootstrap-only state (personas, emojis, commands, permissions, muted ids) has
  no live event, so a reconnect was only ever an incidental refresh of it, not a
  guarantee — no regression. (Invitations are bootstrap-only on the client too
  but for a different reason — their events _are_ logged and broadcast
  workspace-wide, just unhandled on the client; see the `invitation:*` follow-up
  below. Earlier inventory text lumping invitations in with the static "no live
  event" set was imprecise.) Read-before-stamp is moot on
  the slim path (no snapshot for the cursor to race; cursor + unread IDB persist
  across the reconnect, so absolute LWW catch-up converges the counters). The
  slim path swallows its own errors (sets the workspace stale) so it can never
  reject and strand the paused gate. Covered by `sync-engine.test.ts`
  ("active-mode reconnect bootstrap slimming").
- **Per-stream reconnect delta** (`joinStreamForCatchUp` + `bootstrap?after=`):
  this _is_ the per-stream cursor mechanism, already delta-shaped. Keep.
- **`backfillStreamGap` / `detectSequenceGap` / `computeTimelineHoles`**
  (INV-61): in-band dropped-emit _detection_ (a gap is visible the moment the
  next event arrives). The heartbeat now exists but these stay anyway: their
  detection is instant where the heartbeat's is a ≤interval+grace floor, and
  the in-place placeholder rendering is UX, not just healing.
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
- **`invitation:*` (sent / accepted / revoked / link-created / link-claimed)** —
  bootstrap-only on the client; the next additive candidate the owner flagged.
  The five events are real outbox events (`features/invitations/service.ts`).
  They used to fall through `resolveDeliveryGroups` to `WORKSPACE_GROUP` — logged
  and broadcast to every member's socket even though the payloads carry invitee
  `email`, link `tokenHash`, and accepted-user identity (inert only because no
  client read them). **Now permission-scoped (DONE):** `resolveDeliveryGroups`
  routes them to `permissionGroup(members:write)`, so they are logged and emitted
  to the `permission:members:write` group only. Sockets join that room on
  workspace join via `permissionGroupsForRole(role)` (role-derived, mirroring
  `requireWorkspacePermission`'s fallback), and catch-up admits the group for
  holders — the catch-up handler passes the same role-derived `permissionGroups`
  into `listEntriesForUser`, so live and replay delivery stay congruent. This
  mirrors the bootstrap gate (`workspaces/handlers.ts` includes `invitations`
  only for `members:write`). **Client handler now landed (DONE):** a
  gate-registered `invitation:*` handler in `sync/workspace-sync.ts` invalidates
  `invitationKeys.list(workspaceId)` (`api/invitations.ts`; the
  `["invitations", workspaceId]` query the only frontend surface —
  `components/workspace-settings/users-tab.tsx`, settings → users — reads). The
  list used to refresh only on the viewer's own send/revoke/resend mutations and
  on a full workspace bootstrap; now an invitation another admin sends or revokes
  in another session heals a viewer's open list live, and a catch-up replay heals
  it after a disconnect — the standard coverage-proof chain (event type → group
  → `sync_log` → `gate.dispatch`) applies. Pre-change `sync_log` rows that fell
  through to `['workspace']` would have replayed their payloads to non-holders on
  catch-up once a handler existed, so the same change ships a one-time migration
  (`20260613192319_scope_invitation_sync_log_groups.sql`) rewriting their groups
  to `['permission:members:write']` — idempotent (post-scoping rows already carry
  it) and aligned with the live routing, closing the backlog window the 30-day
  retention would otherwise leave open.
- **`refetchOnMount: true`** on saved/scheduled/labels/activity: mount-time
  freshness, not reconnect healing. Out of scope.
- **`useBackgroundBootstrapSync`** (SW prefetch) and **`useAppUpdate`**
  (version check on reconnect): not sync healing.
