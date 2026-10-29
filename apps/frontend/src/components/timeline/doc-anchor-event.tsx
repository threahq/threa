import { StreamTypes, type DocCreatedEventPayload, type StreamEvent } from "@threahq/types"
import { useActors } from "@/hooks"
import { useStreamName } from "@/hooks/use-stream-name"
import { STREAM_ICONS } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { DocEventRow, useDocRowReadable } from "./doc-event-row"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]

interface DocAnchorEventProps {
  event: StreamEvent
  workspaceId: string
}

/** The host timeline's row for `doc:created`: who created the doc, its live title, and the link that opens it in a pane. */
export function DocAnchorEvent({ event, workspaceId }: DocAnchorEventProps) {
  const docId = (event.payload as DocCreatedEventPayload | undefined)?.docId ?? ""
  const { getActorName } = useActors(workspaceId)
  const title = useStreamName(workspaceId, docId)
  const readable = useDocRowReadable(workspaceId, event.streamId, title)
  if (!docId) return null

  const actorName = getActorName(event.actorId, event.actorType)
  const age = formatRelativeTime(new Date(event.createdAt), new Date(), undefined, { terse: true })

  return (
    <DocEventRow docId={docId} readable={readable}>
      <DocGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover:text-primary" aria-hidden />
      <span className="shrink-0">
        <span className="font-medium text-foreground">{actorName}</span> created a doc
      </span>
      {title !== null && (
        <span className="min-w-0 truncate font-medium text-foreground group-hover:text-primary">{title}</span>
      )}
      <span className="ml-auto shrink-0">{age}</span>
    </DocEventRow>
  )
}
