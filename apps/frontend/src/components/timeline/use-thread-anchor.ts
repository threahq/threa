import { createDraftPanelId, usePanel } from "@/contexts"

export interface ThreadAnchorWiring {
  /** The real thread stream id if one exists (persisted thread, or an in-flight
   *  agent thread known via `activityThreadStreamId`), else undefined. */
  effectiveThreadId: string | undefined
  /** Panel url of the real thread, or null when none exists yet. */
  threadHref: string | null
  /** Opaque `draft:<parentStreamId>:<anchorId>` panel id for a not-yet-created thread. */
  draftPanelId: string
  /** Panel url for the draft thread. */
  draftPanelUrl: string
  /** Where "reply in thread" points: the real thread when it exists, else the draft panel. */
  replyUrl: string
}

/**
 * The thread affordance wiring for a timeline anchor — the reusable piece shared
 * by message rows and (in later chunks) threadable cards. `anchorId` is the item's
 * canonical id (`msg_…` message / `event_…` card); the draft panel id is keyed on
 * it, so message anchors produce byte-identical urls to before. Pair the returned
 * `threadHref`/`replyUrl` with `<ThreadSlot>` — the renderer is unchanged.
 */
export function useThreadAnchor(
  streamId: string,
  anchorId: string,
  opts: { threadId?: string | null; activityThreadStreamId?: string }
): ThreadAnchorWiring {
  const { getPanelUrl } = usePanel()
  const effectiveThreadId = opts.threadId ?? opts.activityThreadStreamId ?? undefined
  const draftPanelId = createDraftPanelId(streamId, anchorId)
  const draftPanelUrl = getPanelUrl(draftPanelId)
  const threadHref = effectiveThreadId ? getPanelUrl(effectiveThreadId) : null
  const replyUrl = effectiveThreadId ? getPanelUrl(effectiveThreadId) : draftPanelUrl
  return { effectiveThreadId, threadHref, draftPanelId, draftPanelUrl, replyUrl }
}
