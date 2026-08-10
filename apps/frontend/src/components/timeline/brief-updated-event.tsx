import { BookText } from "lucide-react"
import type { BriefUpdatedEventPayload, StreamEvent } from "@threa/types"
import { useActors } from "@/hooks"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"

interface BriefUpdatedEventProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
}

/**
 * Timeline row for `brief_updated` (roadmap 4.2): the visible trace of the
 * stream's durable brief changing — by a persona via `update_stream_brief` or a
 * member via the settings editor. Brief changes are never silent (INV-69
 * spirit): the row names who changed it, whether it was created or updated
 * (version 1 = created), and, for a persona write, the reason. It deep-links
 * into the Brief section (bottom of the Companion tab) so a reader can review or
 * correct the current text — an action that opens the settings overlay, so a
 * button, not a link (INV-40).
 */
export function BriefUpdatedEvent({ event, workspaceId, streamId }: BriefUpdatedEventProps) {
  const { getActorName } = useActors(workspaceId)
  const { openStreamSettings } = useStreamSettings()
  const payload = event.payload as BriefUpdatedEventPayload | undefined
  if (!payload) return null

  const actorName = getActorName(event.actorId, event.actorType)
  const action = payload.version <= 1 ? "created" : "updated"

  return (
    <div className="py-2 px-3 sm:px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <BookText className="inline-block h-3.5 w-3.5 mr-1.5 -mt-0.5 text-primary" aria-hidden="true" />
        {actorName} {action} the{" "}
        <button
          type="button"
          onClick={() => openStreamSettings(streamId, "companion")}
          className="font-medium text-foreground/80 underline-offset-2 hover:underline"
        >
          stream brief
        </button>
        {payload.reason ? <> — {payload.reason}</> : null}
      </p>
    </div>
  )
}
