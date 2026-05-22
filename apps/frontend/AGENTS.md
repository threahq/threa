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

- **You already have a stream object** → `streamLabel(stream, context?)`. It
  returns a guaranteed non-null string: the resolved name (channel `#slug` /
  `displayName`) when there is one, otherwise the context-appropriate
  placeholder. This is the single call — do **not** append your own
  `?? streamFallbackLabel(...)` tail; the fallback lives inside `streamLabel`:

  ```ts
  const label = streamLabel(stream, "sidebar")
  ```

  When the object can be a DM whose `displayName` may be stale/null (raw socket
  rows carry `displayName: null`), resolve the peer first with
  `resolveDmDisplayName(streamId, users, dmPeers)` before `streamLabel` — or just
  go through `resolveStreamName`/`useStreamName` by id.

  Reach for the nullable `getStreamName(stream)` primitive **only** when you
  genuinely need `null` rather than a placeholder — sort/search keys
  (`getStreamName(s) ?? ""`) or a caller-specific fallback phrase
  (``getStreamName(s) ?? `this ${noun}` ``). If you want a displayable label,
  use `streamLabel`, not `getStreamName`.

`FallbackContext` (`"sidebar" | "activity" | "breadcrumb" | "generic" | "noun"`)
selects context-appropriate placeholder wording for unnamed streams; pass the
one that matches the surface. `streamLabel` defaults to `"generic"`.

### Why this exists

DM display names are computed per-viewer on the backend at bootstrap and are
**not** persisted on the stream row (`displayName` is `null` for DMs on the
wire). Every surface that re-derived this by hand drifted: the Saved view showed
"Unknown", scheduled rows skipped peer resolution, etc. Routing through the
shared resolver is the fix — reach for it instead of writing the lookup again.
