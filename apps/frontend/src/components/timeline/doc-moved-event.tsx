import { Link } from "react-router-dom"
import { StreamTypes, type DocMovedEventPayload, type StreamEvent } from "@threahq/types"
import { useActors } from "@/hooks"
import { usePanel } from "@/contexts"
import { useStreamName } from "@/hooks/use-stream-name"
import { STREAM_ICONS, streamFallbackLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]
const ROW_CLASS =
  "group flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground sm:min-h-0 sm:px-6"
const LINK_CLASS =
  "transition-colors hover:bg-primary/[0.04] focus-visible:bg-primary/[0.04] focus-visible:outline-none"

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
  const { getPanelUrl } = usePanel()
  const { getActorName } = useActors(workspaceId)
  const docName = useStreamName(workspaceId, docId)
  const otherHost = useStreamName(workspaceId, otherHostId) ?? "another stream"
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

  // A doc the viewer can no longer read is not in the cache, and its link would only open a dead pane.
  if (!docName) return <div className={ROW_CLASS}>{content}</div>
  return (
    <Link to={getPanelUrl(docId)} data-doc-id={docId} className={cn(ROW_CLASS, LINK_CLASS)}>
      {content}
    </Link>
  )
}
