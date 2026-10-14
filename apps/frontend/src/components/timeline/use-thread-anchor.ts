import { createDraftPanelId } from "@/contexts"
import { useAgentActivityForAnchor } from "@/stores/agent-activity-store"

export interface ThreadAnchorWiring {
  /** The real thread stream id if one exists — the persisted thread, else the
   *  thread an agent session under this anchor is already running in, which
   *  links before the slower `stream:created` event lands. */
  effectiveThreadId: string | undefined
  /** Opaque `draft:<parentStreamId>:<anchorId>` panel id for a not-yet-created thread. */
  draftPanelId: string
  /** Where "reply in thread" points: the real thread when it exists, else the draft panel. */
  replyPanelId: string
}

/**
 * The thread affordance wiring for a timeline anchor — the reusable piece shared
 * by message rows and threadable cards. `anchorId` is the item's canonical id
 * (`msg_…` message / `event_…` card); the draft panel id is keyed on it. These are
 * panel ids, not urls: a panel url encodes the whole layout, so the leaf that
 * renders the link resolves it with `usePanel().getPanelUrl` and the row stays
 * out of every layout change.
 */
export function useThreadAnchor(
  workspaceId: string,
  streamId: string,
  anchorId: string,
  opts: { threadId?: string | null }
): ThreadAnchorWiring {
  const sessions = useAgentActivityForAnchor(workspaceId, anchorId)
  // Only a session running in ANOTHER stream is this anchor's thread. One this
  // message triggered that runs in this same stream is keyed under the same
  // anchor, and taking its stream id would point the thread link at the stream
  // the viewer is already reading.
  const inFlightThreadId = sessions.find((s) => s.streamId !== streamId)?.streamId
  const effectiveThreadId = opts.threadId ?? inFlightThreadId ?? undefined
  const draftPanelId = createDraftPanelId(streamId, anchorId)
  return { effectiveThreadId, draftPanelId, replyPanelId: effectiveThreadId ?? draftPanelId }
}
