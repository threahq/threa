import type { Querier } from "../../../../db"
import { ContextIntents, ContextRefKinds, type ContextRef } from "@threa/types"
import { HttpError } from "../../../../lib/errors"
import type { Message } from "../../../messaging"
import { MessageRepository } from "../../../messaging"
import { StreamRepository, checkStreamAccess } from "../../../streams"
import { findThreadAnchorContext } from "../../thread-anchor-context"
import { hydrateRenderableItems } from "../renderable-items"
import type { Resolver } from "../types"

type ThreadRef = Extract<ContextRef, { kind: typeof ContextRefKinds.THREAD }>

const MAX_FETCH = 500

/**
 * Total messages we include when DISCUSS_THREAD windows the source stream.
 * Tuned for "Ariadne can read the whole window without losing the plot" —
 * larger windows quickly drown the focal message in unrelated chatter, which
 * is exactly the failure mode this windowing is supposed to fix. If the user
 * needs more, Ariadne can call `get_stream_messages` to pull additional
 * history into a tool result.
 *
 * Exported so callers that surface a "messages in source" count to the user
 * (e.g. the context-pill label in `fetchStreamBag`) can clamp to the actual
 * window size — otherwise the chip claims the AI sees thousands of messages
 * when it's only ever sent ~50.
 */
export const DISCUSS_WINDOW_TOTAL = 50

/**
 * Thread resolver: materializes a thread/scratchpad/channel reference into the
 * inputs manifest + renderable messages the renderer/summarizer need.
 *
 * Access check: the user must be able to see the source stream. Public channels
 * are readable by any workspace member; private streams require membership on
 * the stream or on the root stream (threads inherit root membership).
 */
export const ThreadResolver: Resolver<ThreadRef> = {
  kind: ContextRefKinds.THREAD,

  canonicalKey(ref) {
    return `thread:${ref.streamId}`
  },

  async assertAccess(db, ref, userId, workspaceId) {
    // Single source of truth for "can this user read this stream?": handles
    // workspace-boundary, public-channel, and thread-inherits-from-root cases.
    // Inlining `StreamMemberRepository.isMember` here is the historical footgun
    // (membership ≠ access).
    const stream = await checkStreamAccess(db, ref.streamId, workspaceId, userId)
    if (!stream) {
      // We don't know whether the source is missing, in another workspace, or
      // just inaccessible — pick FORBIDDEN as the safer default so we don't
      // confirm existence of streams the user can't see. Callers that need a
      // 404 vs 403 distinction can re-check with `StreamRepository.findById`.
      throw new HttpError("No access to context source stream", {
        status: 403,
        code: "CONTEXT_SOURCE_FORBIDDEN",
      })
    }
  },

  async fetch(db, ref, options) {
    const stream = await StreamRepository.findById(db, ref.streamId)
    if (!stream) {
      throw new HttpError("Context source stream not found", { status: 404, code: "CONTEXT_SOURCE_NOT_FOUND" })
    }

    // DISCUSS_THREAD takes a narrow, focused window instead of dumping the
    // whole tail. Other intents keep the legacy fetch-then-anchor path (and
    // can opt into windowing later by passing their own intent here).
    const useDiscussWindow = options?.intent === ContextIntents.DISCUSS_THREAD
    const messages = useDiscussWindow
      ? await fetchDiscussWindow(db, ref)
      : await MessageRepository.list(db, ref.streamId, { limit: MAX_FETCH })

    // Apply optional anchoring. `fromMessageId`/`toMessageId` bound the slice
    // by sequence so the bag can pin down a specific range of the thread.
    // The discuss-window path already returns a centered slice, so anchors
    // are skipped there — they're a different slicing primitive that the
    // discuss flow doesn't use (and can't combine with cleanly).
    const anchored = useDiscussWindow ? messages : await applyAnchors(db, messages, ref)

    // Always prepend the thread's anchor when the source is a thread — the reply
    // chain is unintelligible without the message (or card) that spawned it.
    // Anchors intentionally don't exclude the root: a user narrowing to a range
    // of replies still expects the parent to anchor the conversation.
    // `findThreadAnchorContext` is the canonical helper — it filters soft-deleted
    // message roots, renders card anchors as terse context, and returns null for
    // non-threads.
    const root = await findThreadAnchorContext(db, stream)
    const withRoot = root && !anchored.some((m) => m.id === root.id) ? [root, ...anchored] : anchored

    const hydrated = await hydrateRenderableItems(db, stream.workspaceId, withRoot)
    const tail = hydrated.items[hydrated.items.length - 1]

    // The focal message is only meaningful when it actually shows up inside
    // the windowed slice. We check `messages` (the discuss window) rather
    // than `items` (which has the thread root prepended): if the user
    // clicked on a thread root, `findSurrounding` won't locate it inside
    // the thread stream and we'll have fallen through to the recent-tail
    // path — even though the prepended root will land in `items`, that's
    // not "the origin is in the window," so don't fabricate a focal section.
    const focalMessageId =
      useDiscussWindow && ref.originMessageId && messages.some((m) => m.id === ref.originMessageId)
        ? ref.originMessageId
        : null

    return {
      ...hydrated,
      tailMessageId: tail?.messageId ?? null,
      focalMessageId,
      visibleMessageIds: null,
      // The source stream is access-checked (assertAccess) and confirmed to
      // exist above, so it's the trusted id to enrich the chip from.
      sourceStreamId: ref.streamId,
    }
  },
}

/**
 * Fetch the DISCUSS_THREAD window: ~50 messages centered on `originMessageId`,
 * or the most recent ~50 messages when there's no focal (slash-command entry
 * point). Rebalances when the focal is near the top or bottom of the stream
 * so the window stays at full size whenever possible — e.g. focal at index 5
 * with 200 messages after returns 5 before + focal + 44 after rather than
 * leaving 19 slots empty.
 */
async function fetchDiscussWindow(db: Querier, ref: ThreadRef): Promise<Message[]> {
  if (!ref.originMessageId) {
    // No focal: return the most recent N messages (chronological order).
    return MessageRepository.list(db, ref.streamId, { limit: DISCUSS_WINDOW_TOTAL })
  }

  // Fetch generously on both sides so we can rebalance below without a second
  // round-trip. `findSurrounding` filters soft-deletes and returns
  // chronological order with the target included.
  const surrounding = await MessageRepository.findSurrounding(
    db,
    ref.originMessageId,
    ref.streamId,
    DISCUSS_WINDOW_TOTAL,
    DISCUSS_WINDOW_TOTAL
  )
  if (surrounding.length === 0) {
    // Origin doesn't resolve in this stream (wrong id, deleted, different
    // stream). Fall back to the most-recent slice so the user still gets a
    // useful context — matching the slash-command shape.
    return MessageRepository.list(db, ref.streamId, { limit: DISCUSS_WINDOW_TOTAL })
  }

  const targetIdx = surrounding.findIndex((m) => m.id === ref.originMessageId)
  if (targetIdx < 0) {
    // The target's sequence resolved (so `findSurrounding` returned its
    // neighbors) but the target row itself is missing from the slice. The
    // common cause is a soft-deleted focal: `findSurrounding` looks the
    // sequence up without a `deleted_at` filter, but its neighbor query
    // does, so a tombstoned target produces surrounding-without-target.
    // Slicing `surrounding` here would give a window skewed around the
    // deletion point; the slash-command tail is more honest — the user's
    // anchor is unrecoverable, fall back to "what's recent in this stream."
    return MessageRepository.list(db, ref.streamId, { limit: DISCUSS_WINDOW_TOTAL })
  }

  const beforeAvailable = targetIdx
  const afterAvailable = surrounding.length - 1 - targetIdx
  const halfBefore = Math.floor((DISCUSS_WINDOW_TOTAL - 1) / 2)
  const halfAfter = DISCUSS_WINDOW_TOTAL - 1 - halfBefore

  // Pick balanced halves first, then push leftover capacity from the short
  // side onto the long side so the window stays at DISCUSS_WINDOW_TOTAL when
  // possible.
  let takeBefore = Math.min(beforeAvailable, halfBefore)
  let takeAfter = Math.min(afterAvailable, halfAfter)
  const remaining = DISCUSS_WINDOW_TOTAL - 1 - takeBefore - takeAfter
  if (remaining > 0) {
    const extraAfter = Math.min(remaining, afterAvailable - takeAfter)
    takeAfter += extraAfter
    const extraBefore = Math.min(remaining - extraAfter, beforeAvailable - takeBefore)
    takeBefore += extraBefore
  }

  return surrounding.slice(targetIdx - takeBefore, targetIdx + takeAfter + 1)
}

async function applyAnchors<T extends { id: string; sequence: bigint; streamId?: string }>(
  db: Querier,
  messages: T[],
  ref: ThreadRef
): Promise<T[]> {
  if (!ref.fromMessageId && !ref.toMessageId) return messages

  const fromIdx = ref.fromMessageId ? messages.findIndex((m) => m.id === ref.fromMessageId) : 0
  const toIdx = ref.toMessageId ? messages.findIndex((m) => m.id === ref.toMessageId) : messages.length - 1

  // Fail loudly when an anchor can't be located in the fetched window — the
  // caller asked for a narrowed slice and we'd rather surface the mismatch
  // than silently widen to the full (already possibly truncated) window.
  // Distinguish two cases so the frontend can either surface a crisp error
  // (unknown anchor) or propose a workaround (widen the fetch window):
  //   - CONTEXT_ANCHOR_NOT_FOUND — the id doesn't exist in this stream at all
  //   - CONTEXT_ANCHOR_OUT_OF_WINDOW — the id exists but predates MAX_FETCH
  if (ref.fromMessageId && fromIdx < 0) {
    await assertAnchorExists(db, ref.streamId, ref.fromMessageId, "fromMessageId")
  }
  if (ref.toMessageId && toIdx < 0) {
    await assertAnchorExists(db, ref.streamId, ref.toMessageId, "toMessageId")
  }

  const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx]
  return messages.slice(lo, hi + 1)
}

async function assertAnchorExists(
  db: Querier,
  streamId: string,
  anchorId: string,
  label: "fromMessageId" | "toMessageId"
): Promise<never> {
  // `MessageRepository.findById` does NOT filter `deleted_at`, but
  // `MessageRepository.list` (which produced the search window) does. So a
  // soft-deleted anchor would otherwise look like a live row and get
  // mis-labeled OUT_OF_WINDOW — the suggested workaround (widen the window)
  // can never recover it. Treat soft-deleted anchors as not-found.
  const anchor = await MessageRepository.findById(db, anchorId)
  const existsInStream = anchor !== null && anchor.streamId === streamId && !anchor.deletedAt
  if (!existsInStream) {
    throw new HttpError(`${label} anchor not found in this stream`, {
      status: 422,
      code: "CONTEXT_ANCHOR_NOT_FOUND",
    })
  }
  throw new HttpError(`${label} anchor exists but predates the fetched window (MAX_FETCH=${MAX_FETCH})`, {
    status: 422,
    code: "CONTEXT_ANCHOR_OUT_OF_WINDOW",
  })
}
