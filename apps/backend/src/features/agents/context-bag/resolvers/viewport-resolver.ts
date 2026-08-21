import type { Querier } from "../../../../db"
import { ContextRefKinds, type ViewportContextRef } from "@threa/types"
import { HttpError } from "../../../../lib/errors"
import type { Message } from "../../../messaging"
import { MessageRepository } from "../../../messaging"
import { StreamRepository, checkStreamAccess } from "../../../streams"
import { findThreadAnchorContext } from "../../thread-anchor-context"
import { VIEWPORT_WINDOW_PAD, VIEWPORT_WINDOW_TOTAL } from "../config"
import { hydrateRenderableItems } from "../renderable-items"
import type { Resolver } from "../types"

/**
 * Viewport resolver: materializes "what the user had on screen" into the
 * inputs manifest + renderable messages. The client only reports the visible
 * message ids; the expansion to a readable window happens here — sibling
 * messages padded on both sides of the visible span (`VIEWPORT_WINDOW_PAD`),
 * the whole thing capped at `VIEWPORT_WINDOW_TOTAL`, plus the thread anchor when
 * the host is a thread. Visible ids that no longer resolve in the host stream
 * (deleted, foreign, mistyped) are dropped; if none survive the resolver falls
 * back to the stream's recent tail so the aside still has grounding.
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

    const byId = await MessageRepository.findByIdsInWorkspace(db, stream.workspaceId, ref.visibleMessageIds)
    const visible = [...byId.values()]
      .filter((m) => m.streamId === ref.streamId && m.deletedAt === null)
      .sort((a, b) => Number(a.sequence - b.sequence))

    const window =
      visible.length > 0
        ? await fetchViewportWindow(db, ref.streamId, visible)
        : await MessageRepository.list(db, ref.streamId, { limit: VIEWPORT_WINDOW_TOTAL })

    const root = await findThreadAnchorContext(db, stream)
    const withRoot = root && !window.some((m) => m.id === root.id) ? [root, ...window] : window

    const hydrated = await hydrateRenderableItems(db, stream.workspaceId, withRoot)
    const tail = hydrated.items[hydrated.items.length - 1]
    const inWindow = new Set(window.map((m) => m.id))
    const visibleInWindow = visible.filter((m) => inWindow.has(m.id)).map((m) => m.id)

    return {
      ...hydrated,
      tailMessageId: tail?.messageId ?? null,
      focalMessageId: null,
      visibleMessageIds: visibleInWindow.length > 0 ? visibleInWindow : null,
      sourceStreamId: ref.streamId,
    }
  },
}

/**
 * The visible span padded with `VIEWPORT_WINDOW_PAD` siblings on each side, in
 * chronological order, capped at `VIEWPORT_WINDOW_TOTAL`. One round-trip: fetch
 * from the first visible message forward far enough to cover the span and its
 * trailing pad, then cut after the last visible message + pad. When the span
 * itself exceeds the cap the trailing pad goes first, then the span's own tail —
 * the top of what the user saw is the lead-in they were reading from.
 */
async function fetchViewportWindow(db: Querier, streamId: string, visible: Message[]): Promise<Message[]> {
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
  const end = lastIdx >= 0 ? lastIdx + VIEWPORT_WINDOW_PAD + 1 : surrounding.length
  return surrounding.slice(0, Math.min(end, VIEWPORT_WINDOW_TOTAL))
}
