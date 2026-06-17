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

### E2E sealed names resolve through the same path

An E2E scratchpad's name can be sealed (the enclave auto-title, or a manual
rename re-sealed under the SSK). The server-mutable plaintext `displayName` is
only the locked-state fallback; an unlocked owner should see the tamper-evident
decrypted copy. You do **not** thread this through call sites: `useWorkspaceStreams`
overlays the decrypted name onto `displayName` at the store-read boundary, so
`streamLabel`/`resolveStreamName`/`useStreamName` already reflect it everywhere.
The plaintext is held only in the memory-only `lib/crypto/stream-name-cache`
(decrypt authority), never persisted — IDB keeps `sealedNameCiphertext`. A locked
session shows the placeholder; the open-stream header reads the same cache via
`useDecryptedStreamName`. Don't re-decrypt names per surface — extend the cache /
overlay if a new surface bypasses the workspace store.

**Loading state goes through the single authority.** The decrypted _value_ is
transparent through the overlay above, but "is this sealed name still resolving"
(show a loader vs. the placeholder) needs the session, so it has exactly one
owner: `useSealedNamePendingResolver(workspaceId)` in `use-decrypted-stream-name`.
It wires `useE2eSession` + the name-cache subscription once and returns a resolver;
list surfaces apply it across rows (the sidebar builder's `nameDecrypting`, the
coordinated-loading reveal gate's `.some`) and the open-stream header reads one
stream via `useStreamNameDecrypting`. Do **not** re-pair `useE2eSession` with the
cache version yourself — that triple drifted across three surfaces before it was
collapsed here. A new surface that needs the loading state calls the resolver; it
never reaches for the session directly.

### Why this exists

DM display names are computed per-viewer on the backend at bootstrap and are
**not** persisted on the stream row (`displayName` is `null` for DMs on the
wire). Every surface that re-derived this by hand drifted: the Saved view showed
"Unknown", scheduled rows skipped peer resolution, etc. Routing through the
shared resolver is the fix — reach for it instead of writing the lookup again.

## Renaming an E2E (sealed) stream

An E2E stream's name is **sealed-only**: a rename persists only the
tamper-evident ciphertext on `e2e_streams` and never the plaintext
`streams.display_name` (the server scrubs it to null when a sealed name is set —
INV-E1, no plaintext at rest). This matches the enclave auto-title, which has
always written the sealed columns only.

- **One sealing path.** Both rename surfaces — the open-stream header
  (`useStreamOrDraft().rename`) and stream settings (`DisplayNameSection`) — go
  through `sealStreamRename` in `lib/crypto/stream-rename.ts`. Don't re-derive
  the seal; call it. It throws `StreamNameSealUnavailableError` rather than ever
  falling back to plaintext.
- **Renaming requires an unlocked session** (sealing needs the SSK). Gate the
  rename affordance on `useE2eSession(...).status === "unlocked"`; it's hidden in
  the header menu and read-only in settings while locked.
- **Known residuals** (accepted, not bugs): server-side name search
  (ILIKE/`similarity` on `display_name`) can't see E2E streams — their names are
  searchable only client-side over the decrypted copy. Streams renamed _before_
  this shipped still hold plaintext in `display_name`; the server can't re-seal
  them, so they stay until the owner renames again while unlocked.

## How to add an encrypted field (the decrypt layer)

Every client-side encrypted field (message bodies, trace steps, stream names,
drafts, attachment bytes) decrypts through one shared layer under
`lib/crypto/`. Ciphertext stays at rest in IDB; plaintext is memory-only and
cleared on lock (E2EE-4). Don't hand-roll a new cache, session gate, or
hydration guard — reuse the three pieces below, and a new field needs no new
session wiring and no copied footgun.

1. **A cache instance, not a new cache.** Call
   `createDecryptedCache<{ status, value }>(...)` from `lib/crypto/decrypted-cache.ts`.
   Every entry is `{ status: "pending" | "decrypted" | "failed"; value: V | null }` —
   keep that uniform shape (`value`, not a field named after the domain). Pick:
   - `subscription`: `"per-key"` for many keys where one resolve must not re-render
     the rest (messages, attachments); `"global"` for few keys read as a list (names).
   - `retryFailed`: `false` when a miss is terminal (a message id's decrypt can't
     start succeeding); `true` when a null open is transient (locked / not-yet-a-
     recipient / a network blip — names, attachment bytes).
   - `lru`: cap when entries are unbounded in count or large in size (messages 500,
     attachment blobs 64); omit for a small bounded set (names).

   The instance auto-registers its `clear` in the lock-clear registry, so
   `clearAllDecrypted()` (the single lock / account-switch site in
   `e2e-session-store`) wipes it — you do **not** add a clear call. A cache can only
   hold plaintext if its module is loaded, and loading registers it.

2. **Gate the decrypt through `resolveDecryptContext`** (`lib/crypto/decrypt-context.ts`)
   for any field keyed under a stream's SSK. It owns the unlocked check
   (`isSessionUnlocked`), root-SSK resolution, and the hold-until-the-stream-row-
   hydrates guard — decrypting a thread's content against its own id finds no wrap,
   fails, and caches that failure **forever**, so never decrypt against a bare
   `streamId` when the row is unhydrated. Read the row with `useStreamFromStore` and
   pass it in; `{ ready: false }` means hold at `locked`/`pending`, never attempt.

3. **A per-domain read hook returning a `{ status }` discriminated union**
   (`plaintext | locked | pending | decrypted | failed`). Subscribe to the cache
   with `useSyncExternalStore` (per-key) and fire `request(...)` from an effect
   whose deps are the **primitive opts fields** (`opts?.privateKey`, …,
   `opts?.rootStreamId`), not the per-render `opts` object — a fresh object every
   render would re-fire settled decrypts on unrelated row updates. Keep hooks
   per-domain (typed returns) rather than one generic hook; they share the helpers
   above, not the hook. `useDecryptedMessageContent` is the reference shape;
   `useDecryptedAttachment` mirrors it (and owns the object-URL lifecycle so the
   blob in the cache never leaks past unmount/lock).
