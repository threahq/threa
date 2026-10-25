import { Link } from "react-router-dom"
import { StreamTypes, type DocCreatedEventPayload, type StreamEvent } from "@threahq/types"
import { useActors } from "@/hooks"
import { usePanel } from "@/contexts"
import { useStreamName } from "@/hooks/use-stream-name"
import { STREAM_ICONS } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]

interface DocAnchorEventProps {
  event: StreamEvent
  workspaceId: string
}

/** The host timeline's row for `doc:created`: who created the doc, its live title, and the link that opens it in a pane. */
export function DocAnchorEvent({ event, workspaceId }: DocAnchorEventProps) {
  const docId = (event.payload as DocCreatedEventPayload | undefined)?.docId ?? ""
  const { getPanelUrl } = usePanel()
  const { getActorName } = useActors(workspaceId)
  const title = useStreamName(workspaceId, docId) ?? "Untitled"
  if (!docId) return null

  const actorName = getActorName(event.actorId, event.actorType)
  const age = formatRelativeTime(new Date(event.createdAt), new Date(), undefined, { terse: true })

  return (
    <Link
      to={getPanelUrl(docId)}
      data-doc-id={docId}
      className="group flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-primary/[0.04] focus-visible:bg-primary/[0.04] focus-visible:outline-none sm:min-h-0 sm:px-6"
    >
      <DocGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover:text-primary" aria-hidden />
      <span className="shrink-0">
        <span className="font-medium text-foreground">{actorName}</span> created a doc
      </span>
      <span className="min-w-0 truncate font-medium text-foreground group-hover:text-primary">{title}</span>
      <span className="ml-auto shrink-0">{age}</span>
    </Link>
  )
}
