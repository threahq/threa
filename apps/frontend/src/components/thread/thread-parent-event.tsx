import { Separator } from "@/components/ui/separator"
import { EventItem } from "@/components/timeline"
import type { StreamEvent } from "@threa/types"

interface ThreadParentEventProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
  replyCount: number
}

/**
 * The anchor item pinned at the top of a thread panel, above the "N replies" bar.
 * Anchor-agnostic: it renders through the `EventItem` dispatcher, so a message
 * anchor (`message_created`/`companion_response`) renders exactly as a message
 * does inline and a card anchor (`delegation:created`, `call_started`) renders as
 * its card — no thread affordance inside the parent render (`isThreadParent`
 * suppresses the message row's own ThreadSlot; cards carry no affordance here).
 * A card outside its patch window renders pre-patch (its `call_ended` /
 * `delegation:status_changed` isn't fetched into the panel) — accepted, the
 * parent timeline is authoritative.
 */
export function ThreadParentEvent({ event, workspaceId, streamId, replyCount }: ThreadParentEventProps) {
  return (
    <div className="border-b">
      <div className="pt-4 pb-2">
        <div className="mx-auto max-w-[800px] w-full min-w-0">
          <EventItem event={event} workspaceId={workspaceId} streamId={streamId} isThreadParent />
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
