import { StreamTypes, type DocMovedEventPayload, type StreamEvent } from "@threahq/types"
import { useActors } from "@/hooks"
import { useStreamName } from "@/hooks/use-stream-name"
import { STREAM_ICONS, streamFallbackLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { DocEventRow, useDocRowReadable } from "./doc-event-row"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]

interface DocMovedEventProps {
  event: StreamEvent
  workspaceId: string
  streamId: string
}

/** A host timeline's row for `doc:moved`, read from this host's side: moved to the other host, or here from it. */
export function DocMovedEvent({ event, workspaceId, streamId }: DocMovedEventProps) {
  const payload = event.payload as Partial<DocMovedEventPayload> | undefined
  const docId = payload?.docId ?? ""
  const movedHere = payload?.toStreamId === streamId
  const otherHostId = (movedHere ? payload?.fromStreamId : payload?.toStreamId) ?? ""
  const { getActorName } = useActors(workspaceId)
  const docName = useStreamName(workspaceId, docId)
  const otherHost = useStreamName(workspaceId, otherHostId) ?? "another stream"
  const readable = useDocRowReadable(workspaceId, streamId, docName)
  if (!docId) return null

  const actorName = getActorName(event.actorId, event.actorType)
  const age = formatRelativeTime(new Date(event.createdAt), new Date(), undefined, { terse: true })
  const content = (
    <>
      <DocGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover:text-primary" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{actorName}</span> moved{" "}
        <span className="font-medium text-foreground group-hover:text-primary">
          {docName ?? streamFallbackLabel(StreamTypes.DOC, "activity")}
        </span>{" "}
        {movedHere ? (
          <>
            here from <span className="font-medium text-foreground">{otherHost}</span>
          </>
        ) : (
          <>
            to <span className="font-medium text-foreground">{otherHost}</span>
          </>
        )}
      </span>
      <span className="ml-auto shrink-0">{age}</span>
    </>
  )

  return (
    <DocEventRow docId={docId} readable={readable}>
      {content}
    </DocEventRow>
  )
}
