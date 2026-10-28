import { Link } from "react-router-dom"
import { StreamTypes, type DocActivityEventPayload, type StreamEvent } from "@threahq/types"
import { useActors } from "@/hooks"
import { usePanel } from "@/contexts"
import { useStreamName } from "@/hooks/use-stream-name"
import { STREAM_ICONS, streamFallbackLabel } from "@/lib/streams"
import { formatRelativeTime } from "@/lib/dates"
import { joinNames } from "@/lib/join-names"
import { stripMarkdownToInline, truncateInline } from "@/lib/markdown/strip"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]
const MAX_SECTIONS = 3
const MAX_SECTION_LENGTH = 40
const MAX_NAMED_ACTORS = 3

interface DocActivityEventProps {
  /** Adjacent `doc:activity` rows for one doc, oldest first. */
  events: StreamEvent[]
  workspaceId: string
}

function payloadOf(event: StreamEvent): DocActivityEventPayload {
  return event.payload as DocActivityEventPayload
}

/** The host timeline's row for a run of `doc:activity` roll-ups: who edited the doc, where, and the link that opens it. */
export function DocActivityEvent({ events, workspaceId }: DocActivityEventProps) {
  const docId = events[0] ? payloadOf(events[0]).docId : ""
  const { getPanelUrl } = usePanel()
  const { getActorName } = useActors(workspaceId)
  const title = useStreamName(workspaceId, docId) ?? streamFallbackLabel(StreamTypes.DOC, "generic")
  const latest = events[events.length - 1]
  if (!docId || !latest) return null

  const names = new Map<string, string>()
  const sections = new Map<string, string>()
  const removed = new Set<string>()
  for (const event of events) {
    const payload = payloadOf(event)
    for (const actor of payload.actors) {
      names.set(`${actor.actorType}:${actor.actorId}`, getActorName(actor.actorId, actor.actorType))
    }
    for (const section of payload.sections) {
      if (!sections.has(section.blockId)) sections.set(section.blockId, section.markdown)
    }
    for (const blockId of payload.removedBlockIds) removed.add(blockId)
  }

  const latestReason = events.flatMap((event) => payloadOf(event).reasons ?? []).at(-1)
  const reason = latestReason && stripMarkdownToInline(latestReason).trim()
  const labels = [...sections]
    .filter(([blockId]) => !removed.has(blockId))
    .map(([, markdown]) => truncateInline(stripMarkdownToInline(markdown).trim(), MAX_SECTION_LENGTH))
    .filter(Boolean)
  const details = labels.slice(0, MAX_SECTIONS)
  if (labels.length > MAX_SECTIONS) details.push(`+${labels.length - MAX_SECTIONS} more`)
  const age = formatRelativeTime(new Date(latest.createdAt), new Date(), undefined, { terse: true })

  return (
    <Link
      to={getPanelUrl(docId)}
      data-doc-id={docId}
      className="group flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-primary/[0.04] focus-visible:bg-primary/[0.04] focus-visible:outline-none sm:min-h-0 sm:px-6"
    >
      <DocGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover:text-primary" aria-hidden />
      <span className="shrink-0">
        <span className="font-medium text-foreground">{joinNames([...names.values()], MAX_NAMED_ACTORS)}</span> edited
      </span>{" "}
      <span className="min-w-0 shrink truncate font-medium text-foreground group-hover:text-primary">{title}</span>{" "}
      {details.length > 0 && <span className="min-w-0 shrink-[2] truncate">· {details.join(", ")}</span>}{" "}
      {removed.size > 0 && (
        <span className="shrink-0">· {removed.size === 1 ? "1 block removed" : `${removed.size} blocks removed`}</span>
      )}{" "}
      {reason && <span className="min-w-0 shrink-[3] truncate">— {reason}</span>}{" "}
      <span className="ml-auto shrink-0">{age}</span>
    </Link>
  )
}
