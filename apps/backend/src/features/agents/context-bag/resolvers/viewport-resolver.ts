import type { Querier } from "../../../../db"
import { ContextRefKinds, type ViewportContextRef } from "@threahq/types"
import { HttpError } from "../../../../lib/errors"
import type { Message } from "../../../messaging"
import { MessageRepository } from "../../../messaging"
import { StreamRepository, checkStreamAccess, type Stream } from "../../../streams"
import { findThreadAnchorContext } from "../../thread-anchor-context"
import { VIEWPORT_WINDOW_PAD, VIEWPORT_WINDOW_TOTAL } from "../config"
import { hydrateRenderableItems } from "../renderable-items"
import type { Resolver } from "../types"

export const CONTEXT_VIEWPORT_GONE = "CONTEXT_VIEWPORT_GONE"

export interface ViewportWindow {
  stream: Stream
  /** The visible messages that still exist in the host stream, chronological. */
  visible: Message[]
  /** The padded sibling window around the visible span, chronological, capped. */
  window: Message[]
  /** The thread anchor when the host is a thread and it isn't already in `window`. */
  root: Message | null
}

/**
 * Expand a viewport ref to its window: the visible ids that still resolve in
 * the host stream, padded with `VIEWPORT_WINDOW_PAD` siblings on each side and
 * capped at `VIEWPORT_WINDOW_TOTAL`, plus the thread anchor for thread hosts.
 * Visible ids that no longer resolve (deleted, foreign, mistyped) are dropped;
 * returns null when none survive — there is no snapshot to show, and callers
 * must say so rather than substitute something else (INV-11). Shared by the
 * resolver and the chip so both report the same item count.
 */
export async function resolveViewportWindow(
  db: Querier,
  stream: Stream,
  ref: ViewportContextRef
): Promise<ViewportWindow | null> {
  const byId = await MessageRepository.findByIdsInWorkspace(db, stream.workspaceId, ref.visibleMessageIds)
  const inHost = [...byId.values()]
    .filter((m) => m.streamId === ref.streamId && m.deletedAt === null)
    .sort((a, b) => Number(a.sequence - b.sequence))
  // A thread host renders its anchor message above the replies; it lives in
  // the parent stream, so it is the one visible id that is never "in host".
  const anchor = await findThreadAnchorContext(db, stream)
  const anchorVisible = anchor !== null && ref.visibleMessageIds.includes(anchor.id)
  if (inHost.length === 0 && !anchorVisible) return null

  const window = inHost.length > 0 ? await fetchPaddedWindow(db, ref.streamId, inHost, ref.capturedAt) : []
  const root = anchor && !window.some((m) => m.id === anchor.id) ? anchor : null
  const visible = anchorVisible && root ? [root, ...inHost] : inHost
  return { stream, visible, window, root }
}

/**
 * Viewport resolver: materializes "what the user had on screen" into the
 * inputs manifest + renderable messages. The client only reports the visible
 * message ids; the expansion happens in `resolveViewportWindow`. A viewport
 * whose messages are all gone throws `CONTEXT_VIEWPORT_GONE` — the bag
 * resolver omits the ref and logs it, it never presents anything else as the
 * snapshot.
 *
 * Access check: the user must be able to read the host stream — `checkStreamAccess`
 * resolves a thread through its root (INV-62), so a viewport of a thread inside a
 * channel the user belongs to resolves without thread membership.
 */
export const ViewportResolver: Resolver<ViewportContextRef> = {
  kind: ContextRefKinds.VIEWPORT,

  canonicalKey(ref) {
    return `viewport:${ref.streamId}`
  },

  async assertAccess(db, ref, userId, workspaceId) {
    const stream = await checkStreamAccess(db, ref.streamId, workspaceId, userId)
    if (!stream) {
      throw new HttpError("No access to context source stream", {
        status: 403,
        code: "CONTEXT_SOURCE_FORBIDDEN",
      })
    }
  },

  async fetch(db, ref) {
    const stream = await StreamRepository.findById(db, ref.streamId)
    if (!stream) {
      throw new HttpError("Context source stream not found", { status: 404, code: "CONTEXT_SOURCE_NOT_FOUND" })
    }
    const expanded = await resolveViewportWindow(db, stream, ref)
    if (!expanded) {
      throw new HttpError("None of the messages on screen when the aside was opened still exist", {
        status: 410,
        code: CONTEXT_VIEWPORT_GONE,
      })
    }

    const { visible, window, root } = expanded
    const hydrated = await hydrateRenderableItems(db, stream.workspaceId, root ? [root, ...window] : window)
    const tail = hydrated.items[hydrated.items.length - 1]
    const inWindow = new Set(window.map((m) => m.id))
    if (root) inWindow.add(root.id)

    return {
      ...hydrated,
      tailMessageId: tail?.messageId ?? null,
      focalMessageId: null,
      viewport: {
        visibleMessageIds: visible.filter((m) => inWindow.has(m.id)).map((m) => m.id),
        capturedAt: ref.capturedAt,
      },
      sourceStreamId: ref.streamId,
    }
  },
}

/**
 * One round-trip: fetch from the first visible message forward far enough to
 * cover the span and its trailing pad, then cut after the last visible message
 * + pad. When the span itself exceeds the cap the trailing pad goes first, then
 * the span's own tail — the top of what the user saw is the lead-in they were
 * reading from. The trailing pad stops at the capture: messages that arrived
 * after the aside was opened are not part of what was seen, and leaving them
 * out keeps the snapshot stable across turns (the visible span is never cut,
 * whatever a client clock says).
 */
async function fetchPaddedWindow(
  db: Querier,
  streamId: string,
  visible: Message[],
  capturedAt: string
): Promise<Message[]> {
  const first = visible[0]
  const last = visible[visible.length - 1]
  const surrounding = await MessageRepository.findSurrounding(
    db,
    first.id,
    streamId,
    VIEWPORT_WINDOW_PAD,
    VIEWPORT_WINDOW_TOTAL - 1
  )
  const lastIdx = surrounding.findIndex((m) => m.id === last.id)
  const capturedAtMs = Date.parse(capturedAt)
  const before = lastIdx >= 0 ? surrounding.slice(0, lastIdx + 1) : surrounding
  const after =
    lastIdx >= 0
      ? surrounding
          .slice(lastIdx + 1)
          .filter((m) => m.createdAt.getTime() <= capturedAtMs)
          .slice(0, VIEWPORT_WINDOW_PAD)
      : []
  return [...before, ...after].slice(0, VIEWPORT_WINDOW_TOTAL)
}
