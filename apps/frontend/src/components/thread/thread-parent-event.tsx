import { Separator } from "@/components/ui/separator"
import { EventItem } from "@/components/timeline"
import type { MessageAgentActivity } from "@/hooks"
import type { StreamEvent, SubagentSummary } from "@threahq/types"

interface ThreadParentEventProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
  replyCount: number
  /**
   * A card anchor's live state, when the panel's host resolved it. Card anchors
   * are patched by later events in the PARENT stream, which the panel does not
   * load — without these the card renders its create-time face forever, which
   * for a subagent means claiming a finished run is still working.
   */
  subagentStatusPatches?: Map<string, StreamEvent>
  subagentRunFallback?: SubagentSummary
  agentActivity?: Map<string, MessageAgentActivity>
}

/**
 * The anchor item pinned at the top of a thread panel, above the "N replies" bar.
 * Anchor-agnostic: it renders through the `EventItem` dispatcher, so a message
 * anchor (`message_created`/`companion_response`) renders exactly as a message
 * does inline and a card anchor (`delegation:created`, `call_started`) renders as
 * its card — no thread affordance inside the parent render (`isThreadParent`
 * suppresses the ThreadSlot chip + Discuss/Chat on message rows AND cards, which
 * would otherwise loop back to the panel already open).
 * A card outside its patch window renders pre-patch (its `call_ended` /
 * `delegation:status_changed` isn't fetched into the panel) — accepted, the
 * parent timeline is authoritative. A subagent card is the exception: its thread
 * IS this panel, so the host resolves the run's state and passes it in.
 */
export function ThreadParentEvent({
  event,
  workspaceId,
  streamId,
  replyCount,
  subagentStatusPatches,
  subagentRunFallback,
  agentActivity,
}: ThreadParentEventProps) {
  return (
    <div className="border-b">
      <div className="pt-4 pb-2">
        <div className="mx-auto max-w-[800px] w-full min-w-0">
          <EventItem
            event={event}
            workspaceId={workspaceId}
            streamId={streamId}
            isThreadParent
            subagentStatusPatches={subagentStatusPatches}
            subagentRunFallback={subagentRunFallback}
            agentActivity={agentActivity}
          />
        </div>
      </div>
      <Separator />
      <div className="py-2 bg-muted/30 text-xs text-muted-foreground">
        <div className="px-3 sm:px-6 mx-auto max-w-[800px] w-full min-w-0">
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </div>
      </div>
    </div>
  )
}
