# "In this stream" — backend-backed infinite scroller

Design exploration. Status: proposal, no code written. Rev 2 — decisions settled:
occurrence rows **with expandable occurrence lists**, `scope=tree` default, threads anchored at
their anchor message, E2E streams on the client path, and the whole surface offline-first on
the sync engine (not a React-Query list).

## Problem

`deriveStreamContext` (`apps/frontend/src/lib/stream-context/derive.ts`) rebuilds the
panel on every render from `useStreamEvents(streamId)` — the IDB-cached timeline window.
Consequences:

- The panel sees only what the client loaded. A link shared four months ago does not exist
  for it until the user scrolls the timeline back that far.
- There is no pagination: it renders the entire derived set at once.
- Category counts are counts of the loaded window, not of the stream.
- No search.

The one thing that already works: `jumpToEvent` in `stream-content.tsx` fetches a window
around an out-of-window message (`listEventsAround`), so a jump target that is 50k messages
back already resolves. The panel is the only missing half.

Target: the panel becomes _the_ way to navigate a stream by artifact — "jump to where that
image / that link was" — with timeline-grade paging, live updates, type filters, and search,
all server-authoritative.

## Why a projection table

The candidate cheap approach — union the existing sources at query time (`attachments`,
`message_link_previews`, `memos`, `delegated_tasks`, `streams`) or scan `stream_events`
payloads — fails on the defining property of this view: it is _sparse_. A stream with 50k
messages and 20 files would scan the whole stream on every page, per category, per keystroke
of search. Sparse-over-dense needs an index, so: a projection (INV-7 — projections commit
with the event that produces them).

## Data model

```sql
CREATE TABLE stream_context_items (
  id                TEXT PRIMARY KEY,              -- sctx_<ulid>
  workspace_id      TEXT NOT NULL,                 -- INV-8
  stream_id         TEXT NOT NULL,                 -- stream the artifact appears in (a thread owns its own items)
  root_stream_id    TEXT NOT NULL,                 -- non-thread ancestor — the scope=tree key AND the access boundary
  category          TEXT NOT NULL,                 -- link|media|file|memo|delegation|thread (INV-3)
  ref_kind          TEXT NOT NULL,                 -- attachment|giphy|url|memo|delegation|thread
  ref_id            TEXT NOT NULL,                 -- RAW identity: attachment id | href as written | memo id | task id | thread stream id
  group_key         TEXT NOT NULL,                 -- collapse key, server-computed: normalizeUrl(href) for links, = ref_id otherwise
  source_message_id TEXT,                          -- jump target; null only for message-less delegations
  author_id         TEXT,                          -- source message's author — backs `from:@user` filtering
  occurred_at       TIMESTAMPTZ NOT NULL,          -- the SOURCE MESSAGE's created_at — the ordering key
  sequence          BIGINT,                        -- stream event sequence when known (tie-break + precise jump)
  snippet           TEXT NOT NULL DEFAULT '',      -- markdown-stripped first line of the source message
  detail            JSONB NOT NULL DEFAULT '{}',   -- ONLY data with no source row (giphy url/title/dims, raw url)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX stream_context_items_identity
  ON stream_context_items (workspace_id, stream_id, category, ref_id, COALESCE(source_message_id, ''));

CREATE INDEX stream_context_items_feed
  ON stream_context_items (workspace_id, root_stream_id, occurred_at DESC, id DESC);

CREATE INDEX stream_context_items_feed_stream
  ON stream_context_items (workspace_id, stream_id, occurred_at DESC, id DESC);

CREATE INDEX stream_context_items_occurrences
  ON stream_context_items (workspace_id, root_stream_id, category, ref_id, occurred_at DESC, id DESC);

CREATE INDEX stream_context_items_message
  ON stream_context_items (workspace_id, source_message_id);
```

Decisions baked in here:

**Occurrence rows, expandable in the UI.** One row per (message × artifact), deduped only
_within_ a message. The feed collapses them per artifact — one landmark per link/image with a
"shared N times" affordance — and expanding lists every occurrence, each with its own
timestamp and its own jump. Today's derive keeps only the most recent occurrence and throws
the rest away, which is the behaviour Kris called out; occurrence rows are what make the
expansion possible at all.

**`root_stream_id` is stored, not joined.** It is simultaneously the `scope=tree` filter key
and the access boundary (INV-62 resolves access through the nearest non-thread ancestor), so
storing it turns both the scoped feed and the access gate into one index lookup with no
recursive stream walk per page. Threads carry the same `root_stream_id` as their parent; a
non-thread stream is its own root.

**No denormalized display data.** `detail` holds only what has no home row (inline Giphy
embeds; a raw URL that never got a preview row). Everything else joins live at read:
`attachments`, `link_previews` via `message_link_previews`, `memos`, `delegated_tasks`,
`streams` (thread reply counts). So an async link-preview fetch, a delegation status change,
or a new thread reply needs **no** re-projection — the projection is an ordered index, not a
cache. This is what keeps the write path small enough to live inside existing transactions.

**`occurred_at` is the message's timestamp**, per the requirement — not the attachment's
upload time (which differs; `attachments.created_at` is reservation time) and not the memo's
capture time (extraction is debounced, so it lands minutes after the conversation).

## Read path

`GET /api/workspaces/:workspaceId/streams/:streamId/context`

| param                       | meaning                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `category`                  | one of the six; omitted = all. Filters _before_ the cursor, so cursors are per-filter (as required). |
| `q`                         | free text; filters before the cursor too                                                             |
| `from` / `before` / `after` | author + date filters, parsed client-side out of the query string                                    |
| `scope`                     | `tree` (default — stream + its threads) or `stream` (this stream only)                               |
| `cursor`                    | opaque `occurred_at,id` keyset                                                                       |
| `limit`                     | default 40                                                                                           |

Keyset exactly as `AttachmentRepository.search` does it (`repository.ts:634`), over the
collapsed set:

```sql
WITH scoped AS (
  SELECT * FROM stream_context_items
  WHERE workspace_id = $ws
    AND (${scope === "tree"} AND root_stream_id = $stream OR stream_id = $stream)
    AND (${!category} OR category = $category)
    AND (${!q} OR <search predicate>)
),
grouped AS (
  SELECT s.*,
         ROW_NUMBER() OVER (PARTITION BY category, ref_id ORDER BY occurred_at DESC, id DESC) AS rn,
         COUNT(*)    OVER (PARTITION BY category, ref_id) AS occurrence_count
  FROM scoped s
)
SELECT * FROM grouped
WHERE rn = 1
  AND (${cursorOccurredAt === null}
       OR (occurred_at, id) < ($cursorOccurredAt::timestamptz, $cursorId::text))
ORDER BY occurred_at DESC, id DESC
LIMIT $limit + 1
```

The window pass scans the stream's own (narrow, sparse) index slice per page rather than just
the page. At realistic sizes — thousands of rows per stream, not millions — that is the right
trade for correct collapse. If a pathological stream ever makes it hurt, the upgrade is a
maintained `is_latest` flag on write; deliberately not designed in now, because keeping it
correct under concurrent inserts is real work (INV-20) for a problem that may never appear.

`GET …/context/occurrences?category=&refId=&scope=&cursor=` returns one artifact's occurrence
list, newest first, its own keyset over `stream_context_items_occurrences`. That is what the
expand affordance calls.

First page additionally returns `counts` — one `GROUP BY category` over the scoped rows. That
fixes the chips, which today count the loaded window.

Access: one `checkStreamAccess` at the handler (INV-62), then the query filters on the
`root_stream_id` that check resolved — never on raw `stream_members`. Add the regression test
INV-62 calls for: a non-member thread inside a member channel must appear under `scope=tree`.

Search predicate: `ILIKE` across the joined display columns (`link_previews.title`,
`.site_name`, url, `attachments.filename`, `memos.title`, `delegated_tasks.title`, `snippet`),
with `exact` semantics so every match is highlightable — same reason `useStreamSearch` passes
`exact: true`. Rows per stream are sparse by construction, so this is cheap and needs no
maintenance. If a stream ever grows a pathological item count, the upgrade is a materialized
`search_text` + `tsvector` on the projection, refreshed from the preview-completion
transaction — deliberately deferred, not designed in.

## Search — borrow the layering from in-stream search, not its navigation

`useStreamSearch` (`apps/frontend/src/hooks/use-stream-search.ts`) is the right model for
_how the two tiers cooperate_, and the wrong model for _what a result is_.

**Take:**

- **Two-phase local-then-server.** Phase 1 substring-matches the IDB rows and renders instantly;
  phase 2 asks the server for what IDB can't see and merges. That is exactly the local-first
  story this panel needs, and it is strictly better than the "server-first, degraded local
  fallback" I wrote in rev 2 — typing feels instant, and the server only widens the set.
- **Merge by identity, not by position.** In-stream search dedups by message id; here it is the
  deterministic row `key`, which the store already uses.
- **The E2E branch.** For a sealed stream, phase 2 is skipped entirely — the server holds only
  ciphertext, so an ILIKE there can only ever match the placeholder. Local is authoritative.
  That is the same rule as decision 4, and this hook is the existing precedent for it.
- **300ms debounce**, one shared constant.
- `components/search/highlight.tsx` for match highlighting in the rows.

**Leave:**

- **The jump model.** `flatMatches` / `activeMatchIndex` / next-prev / "3 of 17" exist to walk
  matches inside the timeline. The panel filters its own list instead, and each row keeps the
  jump it already has. No active-match cursor, no arrows.
- **`mergeAndSort`'s chronological-ascending order** and the keep-the-active-match-stable
  reconciliation — both are artifacts of the walking model.
- **The one-shot `limit: 50`.** In-stream search does not paginate; this panel must, so phase 2
  is the same cursor-paged endpoint as the unfiltered feed, filtered before the cursor. Filtered
  cursors were the original requirement and they do not survive a 50-row cap.

**One schema consequence:** `useMessageSearch` gets its power from
`lib/search-query-parser.ts` (`from:@user`, `before:`, `after:`). Those three are genuinely
useful here — "that image Anna shared in June" is the exact use case this panel exists for — so
the projection carries `author_id TEXT` (the source message's author) and the panel reuses the
parser for `from:`/`before:`/`after:`, with free text going to the ILIKE predicate. The other
filter types (`in:`, `type:`, `status:`, `with:`) are meaningless in a stream-scoped view and
are dropped, not silently ignored.

`author_id` is the **source message's author — who put it in this stream** — not
`attachments.uploaded_by`. They differ when a body re-references someone else's earlier upload,
and "who shared it here" is the question `from:` is being asked.

The query bar reuses the existing pieces rather than growing a second dialect: the query string
stays the single source of truth, `SearchFilterChips` renders removable chips off
`parseSearchQuery`, and `SearchFilterMenu` supplies the add-filter picker. The menu hardcodes
its filter kinds today, so it takes a `kinds` prop to restrict the panel to
`from`/`before`/`after` — a prop, not a fork (INV-29/43).

## Write path

Every hook is inside an existing transaction, alongside the event it derives from (INV-7).
`attachment_references` is the precedent for all of it — including the refresh-on-edit shape
(`event-service.ts:975`).

| trigger                                            | action                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMessageInTransaction`                       | project links (`extractUrls` + `normalizeUrl` from `link-previews/url-utils.ts`, INV-35), inline Giphy (`collectGiphyEmbeds`), and attachments split media/file by `categoryFromMime` |
| `editMessage`                                      | delete-by-message, re-project (same shape as the `attachment_references` refresh)                                                                                                     |
| `deleteMessage`                                    | delete rows for the message                                                                                                                                                           |
| `moveMessagesToThread`                             | `UPDATE stream_id` for the moved messages' rows — the thread now owns those landmarks                                                                                                 |
| memo capture (`MemoService.processBatch` save txn) | one row per memo, `occurred_at` = latest source message's `created_at`, `source_message_id` = first source id (mirrors `memos:captured`, INV-69)                                      |
| delegation create                                  | one row, `occurred_at` = task `created_at`, jump target = its created event                                                                                                           |
| thread create                                      | one row on the _parent_, `occurred_at` = anchor message's `created_at`                                                                                                                |

Threads are positioned at their anchor, not at last-reply time (today's derive sorts by
`lastReplyAt`). A navigation surface wants stable positions; "3 new replies" is live data the
read join already supplies.

## Backfill

New definition `stream-context-index` in `apps/backend/src/lib/backfill` (pattern:
`features/mentions/mention-backfill.ts`).

- **plan**, per workspace: chunks of ≤500 message ids per non-E2E stream, plus one chunk each
  for that stream's memos / delegations / threads.
- **processChunk**: read `content_json` + attachments, build rows, `INSERT … ON CONFLICT
(identity) DO NOTHING` — idempotent, so redelivery and re-enqueue are safe.
- **enqueue migration** with `process_after = NOW() + INTERVAL '15 minutes'` (INV-67;
  `check:migrations` enforces the ≥10 min delay, and an early claim DLQs as `Unknown backfill`).

Volume is bounded by messages-with-artifacts, not messages.

## E2EE

Sealed streams store `ciphertext`, not `content_json`; the backend cannot see their links or
real filenames (`link-previews/outbox-handler.ts` already skips them for exactly this reason).
So: **E2E streams are not indexed**, and the endpoint answers them with `mode: "client"`.
The panel keeps today's `deriveStreamContext` path for those streams and says so in the UI.
Explicit, not a silent empty list (INV-11).

## Frontend — offline-first, on the sync engine

The panel rides the same rails as the timeline and the board, not a React-Query list. The
board's cutover (IDB `conversations` store, v36) is the template, verbatim in structure:

**IDB store is the read authority.** New Dexie table:

```
streamContextItems: "key, workspaceId, streamId, rootStreamId,
                     [rootStreamId+occurredAt], [streamId+occurredAt], [refKey+occurredAt]"
```

`key` is deterministic and computed identically on both sides —
`${category}:${refId}:${sourceMessageId}` — so a locally-derived row and the server's row for
the same artifact are the same row. The server's ULID `id` never reaches the client. `refId` is
deliberately a **raw** value (an id, or the href exactly as written in the body), never a
derived one: the collapse key `group_key` — `normalizeUrl(href)` for links — is computed
server-side only, so the GitHub/Linear-aware normalizer stays backend-only instead of being
forced into a shared package to keep two implementations byte-identical. Local tail rows carry
no `groupKey` and group by `refId` until the server row reconciles them. The panel
renders from `useLiveQuery` over this store (`useStreamContextItems(rootStreamId, scope)`),
collapsing by `refKey` in the read selector; a live event or an optimistic send re-sorts the
feed in place with no refetch.

**The infinite query is the fetch/seed engine, not the reader** — exactly
`useWorkspaceConversations`: each page `bulkPut`s into IDB and the view reads IDB. Paging state
(next cursor, `hasMore`, oldest-loaded `occurred_at`) lives in a per-(stream, filter) row so
reopening the panel does not re-page what is already cached.

**Writes come from three sources, all into IDB:**

1. Server pages (history, oldest direction).
2. Sync-engine appliers in `stream-sync.ts` — `message_created` / `message_edited` /
   `message_deleted` / `memos:captured` / `delegation:*` / thread creation each map to
   context-row upserts and deletes, using extraction refactored out of `derive.ts` into
   `contextItemsFromEvent(event)`. Catch-up replay after reconnect rebuilds the tail for free.
3. Optimistic sends — a pending row appears the instant you post an image, `_status: "pending"`,
   reconciled by the echo (same `key`, so `bulkPut` overwrites).

**Offline behaviour.** Everything cached renders and filters offline; category filtering and
day grouping are local Dexie work. Reaching the end of the cached window while offline shows an
explicit boundary ("older items unavailable offline") rather than a silent empty tail (INV-11).
Search is local-first then server-completed (see the search section); offline it is simply
phase 1 alone, labelled as such — presenting an incomplete local set as complete is the failure
mode to avoid.

**Occurrence expansion** reads cached occurrence rows first (they are all in IDB), then fetches
`…/context/occurrences` to fill in and seed the rest. The collapsed row shows the server's
`occurrenceCount` when it has one, so a partially-cached artifact never under-reports.

Unchanged: `stream-context-row.tsx` (the server item maps into the existing `ContextItem`
union), `groupItemsByDay` (buckets in render order over a sorted list, so appended pages just
work), the `?smedia=` gallery (navigable set = loaded items, grows with the scroll). Added:
search input, sentinel-driven `fetchNextPage` (`attachment-explorer/explorer-list.tsx` is the
IntersectionObserver precedent — nothing in this app is virtualized, including the timeline, so
paged appends are the house style), and an expand affordance on multi-occurrence rows.

Housekeeping: add the store to the sign-out clear list in `database.ts`, and scope its sweep
the way `events` is scoped by workspace.

## Rollout

Feature-flagged (`defineFlag`, workspace+user — the existing system, no ad-hoc boolean), with
the derive path as fallback. Stack of six (see the layer list at the end).

## Settled decisions

1. Occurrence rows, collapsed per artifact in the feed, **expandable to every occurrence** with
   a per-occurrence jump.
2. `scope=tree` is the default. An item in a thread renders with its thread badge and jumping
   to it opens that thread, then highlights the message.
3. Threads sit at their anchor message's time.
4. E2E streams keep the client-derive path (`mode: "client"`).

## Known bug, deferred

Opening "In this stream" while a thread panel is open closes it instantly. Cause is in
`apps/frontend/src/pages/stream.tsx:164-174`: an effect deletes `?context` whenever
`isPanelOpen && isContextOpen`, so setting `?context=all` from the header is undone on the very
next render. It was written to stop a stale `?context` from resurfacing when a thread closes.
The fix is to make the two panels' precedence explicit rather than reactive — deferred by
request; screen recording captured.

## Risks

- Backfill on a large workspace is the only heavy operation; chunked and idempotent, but worth
  watching the queue after the migration's delay elapses.
- `moveMessagesToThread` is the one write that re-parents existing rows (`stream_id` moves,
  `root_stream_id` usually does not); needs its own test.
- The `key` derivation is load-bearing: client-derived and server rows must produce byte-identical
  keys or the feed double-renders. Raw `refId` values keep this to ids and verbatim hrefs, but it
  still needs a test asserting both paths agree on the same message.
- The grouped read scans the stream's index slice per page. Fine at expected sizes; the `is_latest`
  upgrade is the escape hatch if a stream ever proves otherwise.
- Link items exist from the message body before their preview lands, so a fresh link shows its
  raw URL briefly. Same as the timeline behaves today.

## Stack layers

The offline-first cutover makes the frontend side two PRs, not one:

1. migration + repository + write-path hooks + tests (index written, nothing reads it)
2. backfill definition + enqueue migration
3. read endpoints (feed + occurrences) + `packages/types` contract + access tests
4. IDB store + sync-engine appliers + `contextItemsFromEvent` extracted from `derive.ts`
5. panel cutover behind the flag: paging, server counts, search, occurrence expansion
6. flag removal; `derive.ts` narrowed to the E2E path
