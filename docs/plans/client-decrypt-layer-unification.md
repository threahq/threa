# Client-side decrypt layer unification (design)

**Status:** In progress — slices 0 (PR #955, sealed-name loading-state authority),
1, and 2 are implemented; slice 3 pending. Targets current
`origin/main` (post-#946, Stage 4c E2E draft roaming); the implementing branch
must rebase onto it (the inventory below reflects post-#946 reality).

**Posture (decided):** Ciphertext stays at rest on the client (IndexedDB keeps
ciphertext; plaintext is memory-only, cleared on lock). This is option **C** from
the scoping discussion — NOT plaintext-in-IDB. The goal is ergonomic, not a
weakening of E2EE-4: make reading an encrypted field as cheap as reading a
plaintext one, so features stop re-implementing the decrypt machinery and drifting.

## Problem

Every field that lives encrypted in IndexedDB (or as server-relayed ciphertext)
is decrypted on the client through its own hand-rolled machinery. The machinery
is ~the same each time — an in-memory cache keyed by some ciphertext id, an
inflight-dedup, a lock-epoch guard so a decrypt that resolves after lock can't
write plaintext back, a subscribe/version signal, and a session + key-resolution
gate — but it has been re-implemented per field with subtly different shapes. New
fields (and new surfaces over existing fields) copy the nearest example, so the
"fix one surface, miss another" drift is structural, not incidental. PR #955
fixed the status-derivation drift **for stream names only**; this doc generalizes
the fix to every encrypted field.

## Inventory: every client-side decrypt path (current)

| Domain                           | Ciphertext at rest                                                                                            | Decrypted plaintext held in                                                                                                | Status model                                                                                    | Read surface(s)                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Stream names                     | `CachedStream.sealedNameCiphertext/Envelope`                                                                  | `lib/crypto/stream-name-cache.ts` — Map + **global** version + `attempted` set                                             | _implicit_ (names/inflight/attempted) + a **separate** session-aware `resolveSealedNamePending` | value overlay in `useWorkspaceStreams`; status via `useSealedNamePendingResolver`; header `useDecryptedStreamName` |
| Message bodies                   | `CachedEvent.payload.ciphertext/envelope` (`message_created`)                                                 | `lib/crypto/decrypt-cache.ts` — Map + **per-key** listeners + LRU(500)                                                     | _explicit_ union `pending\|decrypted\|failed`                                                   | `useDecryptedMessageContent` → `plaintext\|locked\|pending\|decrypted\|failed`                                     |
| Agent trace steps                | `AgentSessionStep.contentCiphertext/contentEnvelope`                                                          | **same** `decrypt-cache.ts`, keyed by `step.id`                                                                            | same explicit union                                                                             | `useDecryptedStepContent` (explicitly "mirrors `useDecryptedMessageContent`")                                      |
| Message search                   | reads `CachedEvent` ciphertext                                                                                | warms `decrypt-cache.ts` via `requestDecryption`                                                                           | reads `entry.status`                                                                            | `useStreamSearch` — its own `sessionRef` + root resolution                                                         |
| Attachments                      | server-stored opaque ciphertext; per-file key/iv/filename sealed inside the message's `attachmentRefs`        | `attachment-crypto.ts` `pendingRefs` (**pre-send key bridge only**); **no read cache**                                     | **none** — component `useState(url/failed)`                                                     | `components/timeline/e2e-attachment-list.tsx` re-fetches + re-decrypts **per mount**                               |
| Draft message bodies (E2E)       | `CachedDraft.ciphertext/envelope/e2eVersion` (Stage 4c, #946); `contentJson` at rest is the empty placeholder | decrypted on load via `decryptDraftContent` → `tryDecryptMessagePayload` (shared `decrypt-cache`); also held in hook state | hook `isLoaded` gate (decrypt-gated init)                                                       | `useDraftMessage` / `useDraftComposer` (reads `useE2eSession` + `useCurrentWorkspaceUserId` internally)            |
| _(supporting)_ Stream keys (SSK) | `CachedE2eKey` (wrapped)                                                                                      | `lib/crypto/stream-key-cache.ts`                                                                                           | n/a                                                                                             | the key layer every content decrypt resolves through                                                               |

Note on the write side: `seal-send.ts:sealOutgoingMessage` is already the **shared** seal path — messages, drafts (`seal-draft.ts`), and renames (`stream-rename.ts`) all go through it. Convergence on the write side already happened; the divergence this doc targets is the **read/decrypt** side.

## Divergence axes (what we're collapsing)

1. **Two hand-rolled content caches, same skeleton, different bodies.**
   `stream-name-cache` (global version, `attempted` set) and `decrypt-cache`
   (per-key listeners, LRU, explicit status entries) both implement Map +
   inflight-dedup + generation/lock-epoch guard + subscribe + clear — copied, not
   shared. Attachments have _no_ cache.
2. **Three status philosophies.** Bodies/steps return a clean `{ status }`
   discriminated union from one hook (the best-factored shape). Names split it
   into an implicit cache value + a separate session-aware pending resolver.
   Attachments model status as component `useState`.
3. **Session-gating + root-SSK key resolution re-derived per surface.**
   `useDecryptedMessageContent`, `useDecryptedStepContent`, `useStreamSearch`, and
   `useDecryptedStreamName` each independently call `useE2eSession`, resolve
   `rootStreamId`, and check `sessionUnlocked`. The subtle invariant **"a thread
   shares its root scratchpad's SSK; hold at `pending` until the stream row
   hydrates, or a decrypt against the bare thread id finds no wrap, fails, and
   poisons the cache permanently"** is copy-pasted across the message, step, and
   search hooks — three copies of a footgun.
4. **Lock-clear is a manual 4-call list at two sites** in `e2e-session-store`
   (`clearDecryptCache`, `clearStreamKeyCache`, `clearStreamNameCache`,
   `clearAttachmentRefCache`). A fifth field means remembering both sites.
5. **Attachments re-fetch + re-decrypt on every mount/scroll** — the one surface
   that most needs a shared cache lifecycle is the one with none.

## Goals / Non-goals

**Goals**

- One cache primitive backing every encrypted-content field.
- One decode entry that owns session + root-SSK resolution + the hydration guard.
- One uniform read shape (`{ value, status }`) across all fields.
- One lock-clear registry — a new field cannot forget a clear site.
- Adding an encrypted field, or a feature that reads one, requires no new session
  wiring and no copied hydration guard.

**Non-goals**

- Not changing the at-rest posture (ciphertext stays in IDB; plaintext stays
  memory-only). No plaintext-in-IDB.
- Not changing what the SSK/key layer (`stream-key-cache`) does — it stays the
  key-resolution layer the content layer depends on.

## Proposed design

Three shared pieces under the read surfaces.

### 1. One cache primitive — `createDecryptedCache<V>()`

Captures the lifecycle every content cache hand-rolls today:

```ts
interface DecryptedCache<V> {
  get(key: string): { status: "pending" | "decrypted" | "failed"; value: V | null }
  // Dedups in-flight, guards against lock-epoch (a decrypt resolving after
  // clear() must not write back), records terminal status.
  request(key: string, decrypt: () => Promise<V | null>): Promise<void>
  // Seed already-known plaintext (optimistic echo / local rename) without crypto.
  prime(key: string, value: V): void
  subscribe(key: string | null, listener: () => void): () => void // null = any-change
  getVersion(key?: string): number
  clear(): void // bumps generation; auto-registered for lock-clear
}

function createDecryptedCache<V>(opts: {
  subscription: "global" | "per-key" // names = global; bodies/steps = per-key
  lru?: number // bodies = 500; names = unbounded
}): DecryptedCache<V>
```

- `subscription: "global"` reproduces `stream-name-cache`'s single version
  counter (few streams, overlay maps the whole list). `"per-key"` reproduces
  `decrypt-cache`'s per-event listeners (hundreds of messages; a global bump
  would re-render every row).
- The lock-epoch guard, inflight-dedup, and `prime` (today's `primeStreamName` /
  `seedDecryption`) all live here once.
- `createDecryptedCache` self-registers its `clear` in a module registry.

Instances: `nameCache`, `messageCache`, (steps reuse `messageCache` as today),
`attachmentBytesCache` (new — gives attachments the read cache they lack).

### 2. One decode entry — `requestFieldDecrypt(...)`

The session + key + hydration logic that the four hooks copy today, in one place:

```ts
// Returns "not-ready" when the session is locked OR the stream row hasn't
// hydrated (root unknown) — the caller holds at locked/pending and does NOT
// attempt a doomed decrypt that would poison the cache.
function resolveDecryptContext(
  workspaceId,
  streamId,
  session,
  streamRow
):
  | { ready: false; reason: "locked" | "unhydrated" }
  | { ready: true; opts: DecryptMessageOpts /* incl. rootStreamId, keyId, privateKey */ }
```

Every field's request path runs through this, so the thread→root-SSK rule and the
"don't poison on a doomed thread-id decrypt" guard exist exactly once.

### 3. One read shape — `{ value, status }`

Adopt the `useDecryptedMessageContent` discriminated union everywhere
(`plaintext | locked | pending | decrypted | failed`). Names and attachments
move onto it. The session-aware "pending" derivation that PR #955 centralized for
names becomes the general case: a `useDecryptedField(...)`-style hook (or the
existing per-domain hooks, thinned to call shared helpers) returns the union, and
list surfaces get a resolver in the #955 shape.

### 4. One lock-clear registry

```ts
function registerDecryptedCache(clear: () => void): void
function clearAllDecrypted(): void // called once on lock / account switch
```

`e2e-session-store`'s two clear sites call `clearAllDecrypted()` instead of the
4-call list. (The SSK cache `clearStreamKeyCache` and the pre-send
`clearAttachmentRefCache` either register too or stay explicit — decided in slice
1; the constraint is "one call site, no field forgotten.")

## Migration slices (each ships green, independently reviewable)

- **Slice 0 — DONE (PR #955):** sealed-name loading-state collapsed into one
  authority. Proves the status-drift and the fix.
- **Slice 1 — DONE.** `createDecryptedCache` (`lib/crypto/decrypted-cache.ts`)
  and the lock-clear registry (`registerDecryptedCache` / `clearAllDecrypted`)
  are extracted; `decrypt-cache` (per-key, LRU 500, terminal failures) and
  `stream-name-cache` (global version, `retryFailed`) are thin instances over it.
  The two divergences are options: `subscription` ("global" | "per-key") and
  `retryFailed`. Behavior is identical — the existing wrapper tests are the guard,
  plus a focused `decrypted-cache.test.ts` for the primitive and registry.
- **Slice 2 — DONE.** `resolveDecryptContext` (`lib/crypto/decrypt-context.ts`)
  owns the session-unlocked check, root-SSK resolution, and the hold-until-the-
  row-hydrates guard (a doomed thread-id decrypt poisons the cache forever).
  `useDecryptedMessageContent`, `useDecryptedStepContent`, and `useStreamSearch`
  route their per-render/per-callback decrypt through it — the three copies of the
  footgun collapse to one. The unlocked predicate is exported as `isSessionUnlocked`
  (a type guard narrowing the key fields non-null); `lib/drafts/decryption.ts`'s
  `isE2eUnlocked` delegates to it, so the draft path shares the 4th copy of the
  session check. The draft does **not** route through `resolveDecryptContext`'s
  row→root step: its root (`e2eStreamId`) is already resolved at the composer
  (`stream?.rootStreamId ?? streamId`) before reaching the draft layer, which then
  operates on a pre-resolved root in batch with no per-draft stream row — so it
  carries no row→root footgun to share. Behavior-preserving; the existing
  message/step/search/draft tests are the guard, plus a focused
  `__tests__/decrypt-context.test.ts`. (One test artifact changed: the search
  integration test now stubs a hydrated stream row, since the hold-until-hydrated
  guard — previously absent from search — now applies there too.)
- **Slice 3 — attachments onto the layer + uniform read.** Give attachment-bytes
  a real cache (`attachmentBytesCache`), move `e2e-attachment-list` off
  per-mount re-decrypt, and align names / attachments / drafts on the
  `{ value, status }` read shape. Document the "how to add an encrypted field"
  recipe in `apps/frontend/AGENTS.md`.

## Risks & mitigations

- **Leaky abstraction across two subscription models.** Risk that a single
  primitive serving both "global version" and "per-key listeners" becomes a
  worse abstraction than two clear modules. _Mitigation:_ `subscription` is the
  only branch; if the two models can't share cleanly, keep two thin instances over
  a shared lock-epoch/inflight core rather than forcing one surface.
- **Reveal-gate deadlock-safety (names).** The coordinated-loading reveal gate
  must still reveal in every terminal state. _Mitigation:_ slice 1 is behavior-
  preserving; the #955 tests + the locked/unlocked reveal-gate tests are the
  regression guard.
- **Cache-poisoning on doomed thread decrypts.** Centralizing the hydration guard
  is the _point_, but getting it wrong regresses every field at once.
  _Mitigation:_ slice 2 lands behind the existing message/step/search tests that
  already encode the "hold until hydrated" behavior.
- **Big-bang temptation.** Doing all surfaces at once is hard to review/bisect.
  _Mitigation:_ the slice boundaries above; each is shippable alone.

## In scope, corrected: E2E draft message bodies

Earlier drafts of this doc (written against a pre-#946 checkout) called sealed
drafts "memory-only, out of scope." That is no longer true. **Stage 4c (#946)
made E2E draft bodies roam as ciphertext** — `CachedDraft.ciphertext/envelope`
at rest, sealed via `seal-draft.ts`, decrypted on load through the shared
`decrypt-cache`. So drafts are a first-class encrypted-content field and a prime
migration target: #946 had to re-thread `useE2eSession` + viewer-id into the
draft hook and extract `useCurrentWorkspaceUserId` from a duplicated lookup —
exactly the per-surface session/decode wiring the unified decode entry (piece 2)
absorbs. The draft read path joins slices 2–3.

## Out of scope / stays divergent (deliberate)

- **Draft _streams_** (`DraftScratchpad`, table `draftScratchpads`) — an unsent
  new scratchpad. Device-local (no `sync/` references), carries no composer
  content, always plaintext. Not an encrypted-content field. (Its name colliding
  with draft _messages_ is the rename follow-up below.)
- **E2E-draft attachments / context refs / stash** — #946 sealed the draft
  _body_ only; these stay session-local pending their own design. Not in this
  layer's first pass.
- **Stream-key cache (SSK)** — the key-resolution layer, not a content cache;
  it stays as-is (the content layer depends on it).
- **Write/seal path** (`seal-send.ts`, `sealOutgoingMessage`, `stream-rename`,
  `seal-draft`) — already converged on `sealOutgoingMessage`. This doc is the
  read/decrypt side only.

## Related follow-up (separate from this layer)

- **Rename draft _streams_ vs draft _messages_.** `DraftScratchpad` (a stream)
  and `CachedDraft`/`useDraftMessage` (a message) both call themselves "draft,"
  which made this very analysis error-prone. Track a focused rename so "draft"
  stops meaning two things. Not a decrypt-layer change; sequenced separately.

## Open questions

1. ~~Does `clearStreamKeyCache` join the registry, or stay explicit?~~
   **Resolved (slice 1): all four register.** `clearStreamKeyCache` and
   `clearAttachmentRefCache` call `registerDecryptedCache(...)` at module load, so
   `e2e-session-store`'s two clear sites each became a single `clearAllDecrypted()`.
   The constraint "one call site, no field forgotten" wins over the keys-vs-plaintext
   distinction: registration is orthogonal to what a cache does (the SSK layer's
   resolution logic is untouched), and a cache can only hold material if its module
   is loaded — and loading registers it — so any cache with data is cleared on lock.
2. Do steps keep sharing `messageCache` (keyed by `step.id`) or get their own
   instance? Leaning: keep sharing — same shape, same LRU pressure profile.
3. Is a single `useDecryptedField` hook worth it, or do the per-domain hooks stay
   (thinned to shared helpers)? Leaning: keep per-domain hooks for typed returns;
   share the helpers, not the hook.
