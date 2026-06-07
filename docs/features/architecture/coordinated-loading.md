---
title: Coordinated Loading
status: shipped
audience: internal
kind: subsystem
invariants: []
entry_points:
  - apps/frontend/src/contexts/coordinated-loading-context.tsx
  - apps/frontend/src/sync/reveal-gate.ts
  - apps/frontend/src/stores/workspace-store.ts
  - apps/frontend/src/hooks/use-coordinated-stream-queries.ts
public_site: false
summary: >
  The first-paint gate for a workspace: it reveals cached content from IndexedDB
  in one coordinated step (blank, then skeleton, then ready) and holds the first
  network bootstrap's IDB write until that paint lands, so an online start is as
  fast as an offline one.
related: [architecture/sync-engine.md, concepts/subscribe-then-bootstrap.md]
---

## The gist

When you open a workspace, two sources of the same data race: the cached read model
already in IndexedDB from your last session, and a fresh bootstrap coming over the socket.
Coordinated loading is the gate that decides what the screen shows while that resolves, and
in what order. It runs only during the initial load of a workspace, and once it reaches
`ready` it never goes back.

It paints from IndexedDB. The cached workspace (streams, users, memberships, unread,
metadata, sidebar config) is read into an in-memory cache and rendered immediately, so a
returning user sees their workspace without waiting on the network. The fresh bootstrap
then flows in reactively through live queries.

The gate exposes one phase to the rest of the app: `loading` (blank), `skeleton`
(placeholder), or `ready` (real content). Two wrappers consume it. `CoordinatedLoadingGate`
renders nothing during `loading` and the app shell from `skeleton` onward;
`MainContentGate` shows the content skeleton until `ready`.

## How it works

`CoordinatedLoadingProvider` owns the phase. On mount it seeds the in-memory cache from
IndexedDB (`seedCacheFromIdb` in `workspace-store.ts`) so the store hooks return real rows
on their first synchronous render instead of empty arrays. It then derives readiness from
four things, all read from the cache rather than the network:

- workspace data is present (the workspace row plus the unread, metadata, and
  sidebar-config singletons),
- local drafts are seeded,
- every visible stream has a usable local record,
- and either avatars have preloaded or the cache was primed from a prior session.

When all of those hold it flips to `ready` once and latches there.

Phase timing is two timers. The screen stays blank for the first `SKELETON_DELAY_MS`
(600ms); only if the load is still going past that does the skeleton appear, so a faster
load goes straight from blank to content with no skeleton frame. Once shown, the skeleton
is sticky: it holds until `ready` and never drops back to blank, so there is no
skeleton-then-blank-then-content flicker. A separate `LOADING_DELAY_MS` (300ms) governs the
top-bar sync indicator, not the skeleton.

If you only need the model, stop here: paint cached IndexedDB content in one coordinated
step, gated on local data and never on the network. The rest is how the fresh bootstrap is
sequenced so it does not slow that paint down.

## Details worth knowing

### Reveal before write (the reveal-gate)

On a warm start the fresh workspace bootstrap writes the same IndexedDB stores the reveal
reads. IndexedDB serializes a read-write transaction against read-only ones on shared
stores, so an un-gated bootstrap write queues the reveal's reads behind it. That is what
made an online start feel slower than an offline one, where nothing writes.

`reveal-gate.ts` coordinates the two. The provider calls
`markInitialRevealComplete(workspaceId)` when it reaches `ready`. The `SyncEngine`, on its
first connect, fetches the bootstrap immediately (freshness is never deferred over the
wire) but then calls `waitForInitialReveal(workspaceId)` before committing
`applyWorkspaceBootstrap`. So the network fetch and the cached paint run in parallel, and
only the write waits for the paint. The wait is bounded by a 2s timeout, so a paint that
never completes cannot strand the write.

The gate is a per-workspace module-level map keyed by the workspace ULID. `resetRevealGate`
is called from `flushModuleStoreCaches` on account switch, alongside the other per-account
caches.

### When the write is not deferred

Three cases write immediately, with no wait:

- Cold start: nothing is cached, so there is no paint to wait for and the bootstrap is the
  first content.
- Partial cache: the workspace row exists but a gating singleton (unread, metadata, or
  sidebar config) is missing, so the gate can only become `ready` after this write. Waiting
  would deadlock until the timeout, so the engine checks for the full set before deferring.
- Reconnect: content is already on screen, so the refresh lands promptly.

The engine also bails before the write if it was torn down during the wait (`isDestroyed`),
so a bootstrap from a switched-away account never lands in the now-active account's
database.

### What the reveal does not wait on

The reveal is driven entirely by the cached read model. It does not wait on the network
workspace bootstrap, nor on the per-stream bootstraps (those write the `events` store,
which is disjoint from the workspace stores and so does not contend), nor, when the cache
is primed, on the avatar preload. Avatar preload gates only a genuine cold load, to avoid
an initials-to-avatar flash on first impression.

### Per-stream loading is separate

After the initial load completes, opening a stream is handled by the timeline's own loading
state (`IDB_SKELETON_DELAY_MS`, 200ms, in `use-events.ts`), not this gate. The coordinated
gate reports every stream as idle during the initial load and only surfaces per-stream
loading or error states once it is `ready`. The top-bar indicator stays dark for the first
background sync that overlaps the reveal, and lights up only for a later reconnect resync.

## Invariants

This subsystem does not enforce a numbered invariant. It is the first-paint expression of
the frontend pattern that IndexedDB is the client's source of truth: the UI reads cached
IDB through live queries, and sync writes IDB rather than blocking the paint. Its bootstrap
coordination sits on top of the sync engine's subscribe-then-bootstrap (INV-53).

## Entry points

- `apps/frontend/src/contexts/coordinated-loading-context.tsx`: the provider, the phase
  machine, the two gate wrappers, and the skeleton and indicator timers.
- `apps/frontend/src/sync/reveal-gate.ts`: `markInitialRevealComplete` /
  `waitForInitialReveal` / `resetRevealGate`.
- `apps/frontend/src/stores/workspace-store.ts`: `seedCacheFromIdb` and the in-memory cache
  that lets the first render return real rows.
- `apps/frontend/src/hooks/use-coordinated-stream-queries.ts`: the parallel per-stream
  bootstrap observers the gate reads to decide visible-stream readiness.
