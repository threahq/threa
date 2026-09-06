import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { isRangeValid, serializeToMarkdown, sliceContent } from "@threahq/prosemirror"
import { db } from "@/db"
import { useSharedMessageSlot } from "@/components/slots/context"
import type { AttachmentSummary, ContentRange, JSONContent, StreamType, Visibility } from "@threahq/types"

/**
 * Resolved preview for a shared-message pointer. `authorName` is optional at
 * the resolver level — the caller falls back to the cached attribute name
 * stamped on the node at share time.
 */
export interface SharedMessageResolved {
  status: "resolved"
  contentMarkdown: string
  authorId: string
  actorType: string
  authorName?: string
  editedAt: string | null
  /**
   * Attachments on the source message. Populated from the server-side
   * hydration map when available, and falls back to the cached event
   * payload's `attachments` array otherwise. The shared-message card needs
   * these directly — it doesn't share the timeline's `payload.attachments`
   * render path — so without this fallback, image thumbnails would silently
   * drop whenever a pointer hydrates from IDB cache (e.g. in a thread whose
   * parent message lives in another stream's bootstrap).
   */
  attachments?: AttachmentSummary[]
  /** The source revision this content came from; null on an unpinned pointer. */
  version?: number | null
  /** The source's revision right now; greater than `version` = edited since. */
  currentRevision?: number | null
  /** The span of `version` rendered here; `null` = the whole message. */
  range?: ContentRange | null
}

export interface SharedMessageDeleted {
  status: "deleted"
}

export interface SharedMessageMissing {
  status: "missing"
}

export interface SharedMessagePending {
  /** Still resolving. UI should stay blank for the staggered-skeleton delay. */
  status: "pending"
  /** Becomes true once the staggered-skeleton delay has elapsed. */
  showSkeleton: boolean
}

/**
 * Viewer has no read path to the source message. The card renders a
 * privacy-preserving placeholder showing only the source stream's `kind`
 * and `visibility` — never the content, author, or stream name. Used for
 * re-share chains where a downstream viewer can see the outer pointer
 * but the inner one references a stream they don't have access to.
 */
export interface SharedMessagePrivate {
  status: "private"
  sourceStreamKind: StreamType
  sourceVisibility: Visibility
}

/**
 * Hydration stopped at the recursive depth cap for an accessible chain.
 * The viewer can navigate to the source stream to keep reading. The
 * `streamId` carries from the share-node's cached attrs so we always have
 * a navigable target without an extra fetch.
 */
export interface SharedMessageTruncated {
  status: "truncated"
  streamId: string
  messageId: string
}

export type SharedMessageSource =
  | SharedMessageResolved
  | SharedMessageDeleted
  | SharedMessageMissing
  | SharedMessagePending
  | SharedMessagePrivate
  | SharedMessageTruncated

const SKELETON_DELAY_MS = 300

/**
 * A pointer reduced to what resolves it: which message, which revision of it,
 * which span of that revision. `version: null` is a legacy unpinned pointer and
 * hydrates at whatever the source reads now.
 */
export interface SharedMessageReference {
  messageId: string
  streamId: string
  version: number | null
  range: ContentRange | null
}

/**
 * Resolve a shared-message pointer's preview content in priority order:
 *
 *   1. Server-side slot map (populated on stream bootstrap / events responses
 *      via `SlotsProvider`). Authoritative for persisted pointers and reflects
 *      edits / tombstones.
 *   2. Local IndexedDB event cache. Covers the composer-preview case (pointer
 *      not sent yet, no server hydration exists) and any stream where the
 *      source message has already been paged in by the viewer.
 *   3. Pending — stays in the pending state and exposes `showSkeleton` once
 *      the staggered delay has elapsed, matching the rest of the app's
 *      loading semantics.
 *
 * Remote single-message fetch is intentionally not implemented here; the
 * two-tier cache covers the realistic Slice-1 cases and avoids adding a new
 * backend endpoint for a data shape the server already provides via the
 * hydration map.
 */
export function useSharedMessageSource(reference: SharedMessageReference): SharedMessageSource {
  const { messageId, streamId: sourceStreamId, version } = reference
  // The range arrives as a fresh object on every render (node attrs, parsed
  // href), so memo deps ride on its numbers, not its identity.
  const rangeFrom = reference.range?.from ?? null
  const rangeTo = reference.range?.to ?? null
  const range = useMemo<ContentRange | null>(
    () => (rangeFrom === null || rangeTo === null ? null : { from: rangeFrom, to: rangeTo }),
    [rangeFrom, rangeTo]
  )
  const hydrated = useSharedMessageSlot(messageId, version, range)

  const cachedEvent = useLiveQuery(
    async () => {
      if (!sourceStreamId || !messageId) return null
      const events = await db.events
        .where("[streamId+eventType]")
        .equals([sourceStreamId, "message_created"])
        .filter((e) => (e.payload as { messageId?: string })?.messageId === messageId)
        .toArray()
      return events[0] ?? null
    },
    [messageId, sourceStreamId],
    null
  )

  const resolved = useMemo<SharedMessageSource | null>(() => {
    if (hydrated) {
      if (hydrated.state === "deleted") return { status: "deleted" }
      if (hydrated.state === "missing") return { status: "missing" }
      if (hydrated.state === "private") {
        return {
          status: "private",
          sourceStreamKind: hydrated.sourceStreamKind,
          sourceVisibility: hydrated.sourceVisibility,
        }
      }
      if (hydrated.state === "truncated") {
        return {
          status: "truncated",
          streamId: hydrated.streamId,
          messageId: hydrated.messageId,
        }
      }
      if (hydrated.state === "ok") {
        return {
          status: "resolved",
          contentMarkdown: hydrated.contentMarkdown,
          authorId: hydrated.authorId,
          actorType: hydrated.authorType,
          authorName: hydrated.authorName ?? undefined,
          editedAt: hydrated.editedAt,
          attachments: hydrated.range ? [] : hydrated.attachments,
          version: hydrated.version ?? null,
          currentRevision: hydrated.currentRevision ?? null,
          range: hydrated.range ?? null,
        }
      }
    }

    if (cachedEvent) {
      const payload = cachedEvent.payload as {
        contentMarkdown?: string
        contentJson?: JSONContent
        attachments?: AttachmentSummary[]
        revision?: number
      } | null
      // The cache answers only for the revision the pointer pins. Rendering a
      // newer cached body under an older pin is precisely the silent rewrite
      // pinning exists to prevent, so a mismatch stays pending and waits for
      // the server's slot.
      if (version !== null && payload?.revision !== version) return null
      // Only surface a resolved record when the cached event actually has the
      // fields we need. Fabricating `authorId = ""` / `actorType = "user"` when
      // the schema guarantees them would silently misattribute any event that
      // somehow lacked an actor (corrupt cache, future payload shape); prefer
      // `missing` so the UI falls through to the server-provided attr fallback.
      if (payload?.contentMarkdown && cachedEvent.actorId && cachedEvent.actorType) {
        const currentRevision = payload.revision ?? null
        if (range) {
          // A ranged pointer has no cached body of its own — the slice is cut
          // from the pinned document the cache already holds, which is exactly
          // what the server slices. An out-of-bounds range means the cached doc
          // isn't the pinned one after all: wait for the slot.
          if (!payload.contentJson || !isRangeValid(payload.contentJson, range)) return null
          return {
            status: "resolved",
            contentMarkdown: serializeToMarkdown(sliceContent(payload.contentJson, range.from, range.to)),
            authorId: cachedEvent.actorId,
            actorType: cachedEvent.actorType,
            editedAt: null,
            attachments: [],
            version,
            currentRevision,
            range,
          }
        }
        return {
          status: "resolved",
          contentMarkdown: payload.contentMarkdown,
          authorId: cachedEvent.actorId,
          actorType: cachedEvent.actorType,
          editedAt: null,
          attachments: payload.attachments,
          version,
          currentRevision,
          range: null,
        }
      }
      return { status: "missing" }
    }

    return null
  }, [hydrated, cachedEvent, version, range])

  const [showSkeleton, setShowSkeleton] = useState(false)

  // Reset the staggered-skeleton state when the identity of the pointer
  // changes. Otherwise a second pointer that mounts with the hook already
  // in `showSkeleton: true` would skip the 300ms anti-flicker delay and
  // flash a loading state that the rest of the app smooths over.
  useEffect(() => {
    setShowSkeleton(false)
  }, [messageId, sourceStreamId, version, range])

  useEffect(() => {
    if (resolved) {
      setShowSkeleton(false)
      return
    }
    const timer = setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [resolved])

  if (resolved) return resolved
  return { status: "pending", showSkeleton }
}
