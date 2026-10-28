import { memo, useCallback } from "react"
import { Link } from "react-router-dom"
import { StreamTypes } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { usePanel } from "@/contexts"
import { formatRelativeTime } from "@/lib/dates"
import { STREAM_ICONS, streamLabel } from "@/lib/streams"
import { useWorkspaceStreamsSelect, type CachedStream } from "@/stores/workspace-store"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]

/** Narrow on purpose: the selector's result keeps its identity only while these fields stay equal. */
export type HostedDoc = Pick<CachedStream, "id" | "type" | "slug" | "displayName" | "createdAt">

/**
 * The host stream's live docs, newest first. The pane reads this itself and mounts the chip only
 * while there are docs: a docless channel's header then costs no render on a stream switch.
 */
export function useHostedDocs(workspaceId: string, hostId: string | null): HostedDoc[] {
  const selectDocs = useCallback(
    (streams: CachedStream[]): HostedDoc[] =>
      hostId === null
        ? []
        : streams
            .filter(
              (stream) => stream.type === StreamTypes.DOC && stream.parentStreamId === hostId && !stream.archivedAt
            )
            .map(({ id, type, slug, displayName, createdAt }) => ({ id, type, slug, displayName, createdAt }))
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [hostId]
  )
  return useWorkspaceStreamsSelect(workspaceId, selectDocs)
}

interface DocsHeaderChipProps {
  docs: HostedDoc[]
}

interface HostedDocItemsProps {
  docs: HostedDoc[]
  getPanelUrl: (panelId: string) => string
}

function HostedDocItems({ docs, getPanelUrl }: HostedDocItemsProps) {
  const now = new Date()
  return docs.map((doc) => (
    <DropdownMenuItem key={doc.id} asChild>
      <Link to={getPanelUrl(doc.id)} className="flex items-center gap-2">
        <DocGlyph className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{streamLabel(doc, "generic")}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeTime(new Date(doc.createdAt), now, undefined, { terse: true })}
        </span>
      </Link>
    </DropdownMenuItem>
  ))
}

/** A count of the host's docs that opens a menu of them, each opening in a pane. */
export const DocsHeaderChip = memo(function DocsHeaderChip({ docs }: DocsHeaderChipProps) {
  const { getPanelUrl } = usePanel()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2"
          aria-label={docs.length === 1 ? "1 doc" : `${docs.length} docs`}
        >
          <DocGlyph className="h-4 w-4" aria-hidden />
          <span className="text-xs tabular-nums">{docs.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <HostedDocItems docs={docs} getPanelUrl={getPanelUrl} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
