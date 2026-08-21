---
title: Message References
status: shipped
audience: internal
kind: subsystem
invariants: [INV-11, INV-32, INV-56, INV-58, INV-60, INV-64, INV-67]
entry_points:
  - packages/prosemirror/src/positions.ts
  - packages/prosemirror/src/slice.ts
  - packages/prosemirror/src/selection-range.ts
  - packages/prosemirror/src/pointer-urls.ts
  - apps/backend/src/features/messaging/references/
  - apps/backend/src/features/messaging/sharing/hydration.ts
  - packages/types/src/slots.ts
public_site: false
summary: >
  A quote or a share points at one revision of a source message and, optionally,
  one span of it. The server pins both, derives the quote body from the pinned
  span, and hydrates share cards from it, so an edit to the source never rewrites
  what someone quoted or shared.
related: [architecture/sync-log.md, concepts/content-canonical-form.md]
---

## The gist

Two ProseMirror nodes reference another message: `quoteReply` (a blockquote with
attribution, body stored inline) and `sharedMessage` (a card, body hydrated at
read time). Both carry the same reference core:

```ts
{ messageId, streamId, version: number | null, range: { from, to } | null }
```

- **`version`** is the source's revision (`messages.revision`): 1 for the
  original body, +1 per edit. `null` on the wire means unpinned — the server
  pins it to the source's current revision when it writes the node.
- **`range`** is a pair of ProseMirror document positions inside that
  revision's `contentJson`. `null` means the whole message; a range covering
  the whole document is normalized to `null`. Valid iff `0 <= from < to <=
docContentSize`.

`message_versions` stores the **pre-edit** body under the revision number it
was, so version _n_ of an edited message is the row with `version_number = n`
and the current revision has no row.

## Positions and slicing

`packages/prosemirror` owns the position arithmetic, with no dependency on
`prosemirror-model`: text node size is its text length, a leaf or atom is 1, any
other node is `2 + children`. `LEAF_NODE_TYPES` is the list of node types with
no content; an unknown type without content throws rather than guessing a size
(INV-11), and
`apps/frontend/src/components/editor/prosemirror-positions.contract.test.ts`
holds the set against the real tiptap schema in both directions so the two can't
drift.

`sliceContent(doc, from, to)` reproduces PM's `Node.cut`: ancestors of the cut
are kept, text is cut at character boundaries with marks preserved, atoms stay
whole. `resolveSelectionRange(doc, { text, prefixText })` goes the other way —
it maps rendered text back to a range by projecting each textblock to a string
with a per-character position map, so a word split across mark boundaries still
matches and an atom's rendered label is consumed rather than compared.

## Wire forms

Markdown is the external wire format; `contentJson` stays internal (INV-58). A
reference serializes to a pointer link whose query carries the pin:

```text
quote:<streamId>/<messageId>/<authorId>/<actorType>?v=<n>&r=<from>-<to>
shared-message:<streamId>/<messageId>[/<conversationId>]?v=<n>&r=<from>-<to>
```

`?v=` appears only when `version` is non-null and `&r=` only when `range` is
non-null, so `r` never appears without `v`. Both parsers accept the legacy
query-less forms unchanged and report `version: null, range: null` for them.

## Server resolution

`resolveMessageReferences` (`features/messaging/references/resolver.ts`) runs on
every create and every edit, right after mention resolution and before the
version snapshot, the timeline event, the projections and the outbox — so
everything downstream reads one already-pinned body. It is the **only** writer
of a quote's stored body: a client-supplied `snippet` is advisory input, never
trusted output.

Per node it loads the source (one batched `findByIdsInWorkspace`, soft-deleted
rows included), resolves the pinned document (current revision from the
`messages` row, older revisions through one batched
`MessageVersionRepository.findByMessageVersions`), settles the range, and writes
the attrs back. A quote's `snippet` is re-derived as
`sliceReferenceContent(pinnedDoc, range)` — the same helper hydration and the
backfill use, so all three agree byte for byte. Running it over its own output
reports `changed: false` and produces identical JSON.

A rangeless quote with a non-empty snippet gets a **lenient locate**: the
snippet's plain text is matched against the pinned document
(`references/locate.ts`); whole-document equality means `range: null`, a partial
match yields the range, and no match is an error.

One node is exempt from that error: an unpinned quote that was already in the
body being replaced. Its source may have been edited past the quote long ago,
and refusing the write would leave the author unable to edit their own message
ever again. Such a node is carried through untouched; a quote the edit itself
adds is still rejected.

Failures are `HttpError` 400s with stable codes (INV-32), from
`MessageReferenceErrorCodes`:

| Code                          | Cause                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| `REFERENCE_SOURCE_NOT_FOUND`  | No such message in this workspace                                  |
| `REFERENCE_VERSION_NOT_FOUND` | `version` outside `[1, source.revision]`, or its snapshot is gone  |
| `REFERENCE_RANGE_INVALID`     | Range outside the document, or covering no content                 |
| `REFERENCE_RANGE_NOT_FOUND`   | Rangeless quote whose snippet is in no part of the pinned revision |

Cross-stream **access** is not decided here: `ShareService` still runs after
resolution and still owns access, privacy and grants. E2E streams are skipped
entirely — the stored content there is a ciphertext placeholder and carries no
references.

## Hydration and slot keys

A `sharedMessage` node stores no body, so a reader resolves it through a slot.
The key carries the pin (`packages/types/src/slots.ts`):

```text
shared:<messageId>                    unpinned (legacy)
shared:<messageId>@<v>                pinned revision, whole message
shared:<messageId>@<v>:<from>-<to>    pinned revision, one span
```

`parseSharedMessageSlotKey` is its inverse, so a holder of a mixed key space can
route on the result. Hydration groups by `(messageId, version)` and loads one
query per level.

The `ok` slot serves the **pinned** content — sliced when the reference is
ranged — plus `version`, `currentRevision`, and `range`. A card whose
`currentRevision` is greater than its `version` is showing content the source
has since moved past; the client surfaces that as an "Edited since" link rather
than silently updating. A ranged reference carries no attachments (`[]`): the
span, not the message, is what was shared. The other states are the
privacy-safe placeholders — `deleted`, `missing`, `private` (source stream kind
and visibility only, never content or author), and `truncated`.

The public API exposes the same map as a response-level `slots` object with
markdown-only content (`docs/public-api/openapi.json`).

Source edits do not invalidate a pin. The `pointer:invalidated` event still
fires so clients refetch, and the refetch returns the same pinned body with a
higher `currentRevision`.

## Backfilling legacy nodes

Nodes written before pinning carry `version: null`. The
`message-reference-pins` backfill (`references/backfill.ts`, enqueued by
`20260821130000_backfill_message_reference_pins.sql`) converges them across
`messages`, `message_versions`, `scheduled_messages` and `drafts`.

For a legacy quote it tries the stored snippet against candidate revisions —
the one that was live when the quoting row was written first (a
`message_versions.created_at` is the moment that snapshot was _superseded_),
then the rest newest to oldest. The first revision that contains the snippet
sets `version` and `range`, and the snippet is re-derived from that span. When
no revision contains it, the node stays unpinned rather than being pinned to a
body it never quoted. A legacy share pins to its source's current revision,
whole. Sources that no longer exist leave their node untouched.

Each chunk reads set-based and writes one `UPDATE … FROM unnest(...)` for the
rows that actually changed (INV-56); already-pinned nodes are skipped, so
redelivery and re-enqueue are no-ops. The enqueue migration delays
`process_after` by 10 minutes so every replica is running the code that
registers the definition before the first plan job is claimed (INV-67).
