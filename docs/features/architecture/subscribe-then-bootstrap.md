---
title: Subscribe-Then-Bootstrap Pattern
status: shipped
audience: internal
invariants: [INV-53]
entry_points:
  - apps/frontend/src/hooks/use-streams.ts
  - apps/frontend/src/hooks/use-stream-socket.ts
  - apps/frontend/src/sync/workspace-sync.ts
public_site: false
summary: >
  Every socket-room subscribe pairs with a bootstrap fetch, and bootstrap is
  invalidated on reconnect, so no real-time event is ever silently lost.
related: [architecture/outbox-pattern.md, public/configurable-sidebar.md]
---

# Subscribe-Then-Bootstrap Pattern (INV-53)

## The Invariant

**Every socket room subscribe MUST be paired with a bootstrap fetch. No gaps allowed.**

When a client subscribes to a stream's socket room, it must also ensure bootstrap data is fresh. Otherwise, events that occurred between the last unsubscribe and the new subscribe are permanently lost until a full page refresh.

## Why This Exists

Stream data flows through two channels:

1. **Bootstrap** (`useStreamBootstrap`): HTTP fetch of the full stream state — events, members, stream metadata. Cached with `staleTime: Infinity` so it only re-fetches when explicitly invalidated.
2. **Socket** (`useStreamSocket`): Real-time events pushed via Socket.io while the client is subscribed to the room.

The contract: bootstrap provides the initial snapshot, socket provides the delta. If the socket subscription lapses (navigation away, disconnect), events during that gap exist nowhere in the client's state.

## The Gap Scenarios

### Navigate away and back

1. User views stream A — bootstrap fetches, socket subscribes
2. User navigates to stream B — stream A socket unsubscribes (effect cleanup)
3. Message arrives in stream A — `stream:activity` handler invalidates bootstrap cache
4. User navigates back to stream A — socket re-subscribes

Without the fix: `refetchOnMount: false` prevents the invalidated (stale) bootstrap from re-fetching. Data stays stale.

With the fix: `refetchOnMount: true` + `staleTime: Infinity` = refetch only when data is stale (i.e., explicitly invalidated). Fresh cache is a no-op.

### Socket reconnect

1. Client loses connection — socket disconnects
2. Events arrive on server — client misses them
3. Socket reconnects — `reconnectCount` changes, effect re-runs, room re-joined

Without the fix: Room is re-joined but bootstrap data isn't refreshed. Missed events are permanently lost.

With the fix: `useStreamSocket` invalidates bootstrap after re-subscribing (when cache already has data), triggering a background refetch.

## Architecture: Two Hooks

### `useStreamBootstrap` (use-streams.ts)

- React Query observer for stream data
- `staleTime: Infinity` — data never auto-stales
- `refetchOnMount: true` — refetches when data is stale on mount
- First fetch also joins the room via `joinRoomBestEffort` (ensures room membership before data fetch)

### `useStreamSocket` (use-stream-socket.ts)

- Effect that subscribes to socket room and handles real-time events
- Re-runs on `reconnectCount` change (socket reconnect)
- After joining room, invalidates bootstrap if data already exists in cache
- Cleanup: leaves room, detaches all listeners

### `useSocketEvents` (use-socket-events.ts)

- Workspace-level listener for `stream:activity` events
- Invalidates bootstrap cache for non-viewed streams when activity arrives
- This is what marks data as stale so `refetchOnMount: true` triggers the refetch

## Correct Usage

```tsx
function StreamView({ workspaceId, streamId }: Props) {
  // Bootstrap provides the data
  const { data, loadState } = useStreamBootstrap(workspaceId, streamId)

  // Socket keeps it live — invalidates bootstrap on (re-)subscribe
  useStreamSocket(workspaceId, streamId)

  // ...render using data
}
```

Both hooks must be active for the same stream. The socket hook ensures the room subscription stays live and triggers bootstrap refreshes on reconnect.

## Incorrect Usage

```tsx
// BAD: Socket without bootstrap — no data to display
useStreamSocket(workspaceId, streamId)

// BAD: Bootstrap without socket — no real-time updates
const { data } = useStreamBootstrap(workspaceId, streamId)

// BAD: refetchOnMount: false — stale data after invalidation
useQuery({
  queryKey: streamKeys.bootstrap(workspaceId, streamId),
  staleTime: Infinity,
  refetchOnMount: false, // prevents recovery from stale state
})
```
