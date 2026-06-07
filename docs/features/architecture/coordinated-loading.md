---
title: Coordinated Loading
status: shipped
audience: internal
kind: subsystem
invariants: []
entry_points:
  - apps/frontend/src/contexts/coordinated-loading-context.tsx
  - apps/frontend/src/stores/workspace-store.ts
  - apps/frontend/src/hooks/use-coordinated-stream-queries.ts
  - apps/frontend/src/sync/reveal-gate.ts
public_site: false
summary: >
  The single gate that reveals a workspace's app shell and its open stream
  content together, fully resolved, so messages never paint with raw user IDs
  and then jump to names and avatars once the shell catches up.
related: [architecture/sync-engine.md, concepts/subscribe-then-bootstrap.md]
---

## The gist

When you open a workspace, two things load on separate paths: the application shell (the
sidebar and the message chrome that turn user IDs into names and avatars, and stream IDs
into names) and the content of the stream you opened. They do not finish at the same time.

Left uncoordinated, the stream content tends to win the race. It paints first with whatever
it has: raw user IDs, no avatars, no resolved stream names. Then the shell's read model
arrives and the same messages reshuffle, IDs flipping to names and blanks filling in with
avatars. That jump looked bad, and it happened even on a fully cached load, where both
sides are local and milliseconds apart.

Coordinated loading is the one gate that holds both back and reveals them together, in a
single step, once the pieces that let content render correctly are in hand: the workspace
read model (users, so names and avatars resolve; streams and DM peers, so stream names
resolve) and the open stream's content. So the first paint of a stream already has names
and avatars on it, with no post-hoc jump.

It runs only during the initial load of a workspace, and once it reaches `ready` it never
goes back. It paints from IndexedDB: the cached read model from your last session is read
into an in-memory cache and rendered immediately, so a returning user gets this
resolved-first-paint without waiting on the network. The fresh bootstrap then flows in
reactively through live queries.

## How it works

`CoordinatedLoadingProvider` owns a single phase: `loading` (blank), `skeleton`
(placeholder), or `ready` (real content). Two wrappers consume it, and they reveal in
lockstep so the shell and content never paint independently. `CoordinatedLoadingGate`
renders nothing during `loading` and the whole app shell (sidebar included) from `skeleton`
onward; `MainContentGate` shows the content skeleton until `ready`.

On mount the provider seeds the in-memory cache from IndexedDB (`seedCacheFromIdb` in
`workspace-store.ts`) so the store hooks return real rows on their first synchronous render
instead of empty arrays. It then holds the reveal until everything needed for a correct
first paint is present, all read from the cache rather than the network:

- the workspace read model: the workspace row plus users, streams, memberships, DM peers,
  personas, bots, and the unread, metadata, and sidebar-config singletons. This is what
  resolves user IDs to names and avatars and stream IDs to names.
- local drafts are seeded,
- every visible stream has a usable local record (its content),
- and either avatars have preloaded or the cache was primed from a prior session.

When all of those hold it flips to `ready` once and latches there. Avatar preload only
gates a genuine cold load (nothing cached), to avoid an initials-to-avatar flash on the
very first impression; a primed cache reveals immediately and lets avatars stream in
through their own image loads.

Phase timing keeps fast loads clean. The screen stays blank for the first
`SKELETON_DELAY_MS` (600ms); only if the load is still going past that does the skeleton
appear, so a quick load goes straight from blank to a fully-resolved paint with no skeleton
frame. Once shown, the skeleton is sticky: it holds until `ready` and never drops back to
blank, so there is no skeleton-then-blank-then-content flicker.

If you only need the model, stop here: hold the shell and the open stream behind one gate,
reveal them together off cached IndexedDB once names, avatars, and content are all ready.
The rest is detail about freshness and edge cases.

## Details worth knowing

### Reveal before write (the reveal-gate)

This is a refinement on top of the reveal, not its reason for existing. On a warm start the
fresh workspace bootstrap writes the same IndexedDB stores the reveal reads. IndexedDB
serializes a read-write transaction against read-only ones on shared stores, so an un-gated
bootstrap write queues the reveal's reads behind it. That made an online start feel slower
than an offline one, where nothing writes.

`reveal-gate.ts` coordinates the two. The provider calls
`markInitialRevealComplete(workspaceId)` when it reaches `ready`. The `SyncEngine`, on its
first connect, fetches the bootstrap immediately (freshness is never deferred over the
wire) but then calls `waitForInitialReveal(workspaceId)` before committing
`applyWorkspaceBootstrap`. So the network fetch and the cached paint run in parallel, and
only the write waits for the paint, bounded by a 2s timeout. The gate is a per-workspace
module-level map keyed by the workspace ULID; `resetRevealGate` is called from
`flushModuleStoreCaches` on account switch, alongside the other per-account caches.

Three cases write immediately, with no wait: a cold start (nothing cached, so the bootstrap
is the first content), a partial cache (the workspace row exists but a gating singleton is
missing, so the gate can only become `ready` after this write, and waiting would deadlock
until the timeout), and a reconnect (content is already on screen). The engine also bails
before the write if it was torn down during the wait (`isDestroyed`), so a bootstrap from a
switched-away account never lands in the now-active account's database.

### What the reveal does not wait on

It does not wait on the network workspace bootstrap, nor on the per-stream bootstraps (they
write the `events` store, which is disjoint from the workspace stores and so does not
contend), nor, when the cache is primed, on the avatar preload.

### Per-stream loading is separate

After the initial load completes, opening a different stream is handled by the timeline's
own loading state (`IDB_SKELETON_DELAY_MS`, 200ms, in `use-events.ts`), not this gate. The
coordinated gate reports every stream as idle during the initial load and only surfaces
per-stream loading or error states once it is `ready`. The top-bar indicator stays dark for
the first background sync that overlaps the reveal, and lights up only for a later reconnect
resync.

## Invariants

This subsystem does not enforce a numbered invariant. It is the first-paint expression of
the frontend pattern that IndexedDB is the client's source of truth: the UI reads cached
IDB through live queries, and sync writes IDB rather than blocking the paint. Its bootstrap
coordination sits on top of the sync engine's subscribe-then-bootstrap (INV-53).

## Entry points

- `apps/frontend/src/contexts/coordinated-loading-context.tsx`: the provider, the phase
  machine, the two gate wrappers, the readiness conditions, and the skeleton timer.
- `apps/frontend/src/stores/workspace-store.ts`: `seedCacheFromIdb` and the in-memory cache
  that lets the first render return real rows (resolved names and avatars).
- `apps/frontend/src/hooks/use-coordinated-stream-queries.ts`: the parallel per-stream
  bootstrap observers the gate reads to decide visible-stream readiness.
- `apps/frontend/src/sync/reveal-gate.ts`: `markInitialRevealComplete` /
  `waitForInitialReveal` / `resetRevealGate`, the reveal-before-write coordination.
