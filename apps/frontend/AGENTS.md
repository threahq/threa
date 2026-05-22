# Frontend Agent Notes

Scoped guidance for `apps/frontend`. The repo-root `CLAUDE.md` invariants still
apply; this file adds frontend conventions that are easy to reinvent badly.

## Resolving a stream's display name

There is **one** place that knows how to turn a stream into a label:
`apps/frontend/src/lib/streams.ts`. Use it. Do not hand-roll the
slug-vs-`displayName` ternary, do not call `dmPeers.find(...)` and look up the
user yourself, and do not gate DM resolution behind "is the stream object in the
cache" — DM names are viewer-specific and a DM you can open may not be in the
streams cache at all.

Pick the entry point by what you're holding:

- **You have a stream id** (and want the label) → `useStreamName(workspaceId, streamId, context?)`
  from `@/hooks/use-stream-name`. It reads the workspace caches and resolves DM
  peer names, channel slugs, and placeholder fallbacks for you. Returns `null`
  only when the id matches no DM peer and no cached stream — layer your own
  last-resort fallback after it (e.g. a persisted snapshot name):

  ```ts
  const label = useStreamName(workspaceId, streamId) ?? snapshotName ?? "Unknown"
  ```

  In a non-hook context (list mappers, tests) call the pure
  `resolveStreamName(streamId, { streams, users, dmPeers }, context?)` directly.

- **You already have a stream object** → `getStreamName(stream)` (channel → `#slug`,
  otherwise `displayName`), falling back to `streamFallbackLabel(stream.type, context)`
  when it returns `null`:

  ```ts
  const label = getStreamName(stream) ?? streamFallbackLabel(stream.type, "sidebar")
  ```

  When the object can be a DM whose `displayName` may be stale/null (raw socket
  rows carry `displayName: null`), resolve the peer first with
  `resolveDmDisplayName(streamId, users, dmPeers)` before falling back to the
  object's own name — or just go through `resolveStreamName`/`useStreamName` by id.

`FallbackContext` (`"sidebar" | "activity" | "breadcrumb" | "generic" | "noun"`)
selects context-appropriate placeholder wording for unnamed streams; pass the
one that matches the surface.

### Why this exists

DM display names are computed per-viewer on the backend at bootstrap and are
**not** persisted on the stream row (`displayName` is `null` for DMs on the
wire). Every surface that re-derived this by hand drifted: the Saved view showed
"Unknown", scheduled rows skipped peer resolution, etc. Routing through the
shared resolver is the fix — reach for it instead of writing the lookup again.
