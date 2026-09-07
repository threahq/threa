import { createDraftPanelId, usePanel } from "@/contexts"
import { useAgentActivityForAnchor } from "@/stores/agent-activity-store"

export interface ThreadAnchorWiring {
  /** The real thread stream id if one exists — the persisted thread, else the
   *  thread an agent session under this anchor is already running in, which
   *  links before the slower `stream:created` event lands. */
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
  workspaceId: string,
  streamId: string,
  anchorId: string,
  opts: { threadId?: string | null }
): ThreadAnchorWiring {
  const { getPanelUrl } = usePanel()
  const sessions = useAgentActivityForAnchor(workspaceId, anchorId)
  // Only a session running in ANOTHER stream is this anchor's thread. One this
  // message triggered that runs in this same stream is keyed under the same
  // anchor, and taking its stream id would point `threadHref` at the stream the
  // viewer is already reading.
  const inFlightThreadId = sessions.find((s) => s.streamId !== streamId)?.streamId
  const effectiveThreadId = opts.threadId ?? inFlightThreadId ?? undefined
  const draftPanelId = createDraftPanelId(streamId, anchorId)
  const draftPanelUrl = getPanelUrl(draftPanelId)
  const threadHref = effectiveThreadId ? getPanelUrl(effectiveThreadId) : null
  const replyUrl = effectiveThreadId ? getPanelUrl(effectiveThreadId) : draftPanelUrl
  return { effectiveThreadId, threadHref, draftPanelId, draftPanelUrl, replyUrl }
}
