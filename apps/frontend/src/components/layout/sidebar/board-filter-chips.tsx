import { useMemo, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { Layers, Plus, Tag } from "lucide-react"
import {
  useWorkspaceDmPeers,
  useWorkspaceLabels,
  useWorkspaceStreams,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import { resolveStreamName, STREAM_ICONS } from "@/lib/streams"
import { FilterChip } from "@/components/board/board-filter-bar"
import { SaveCurrentViewDialog } from "@/components/board/board-saved-views"
import { useBoardSelection } from "@/hooks/use-board-selection"
import { BOARD_STREAM_TYPE_LABELS } from "@/lib/board/stream-type-labels"
import {
  BOARD_SCOPE_PARAM,
  BOARD_EXCLUDE_SCOPE_PARAM,
  BOARD_TYPE_PARAM,
  BOARD_EXCLUDE_TYPE_PARAM,
  BOARD_LABEL_PARAM,
  BOARD_EXCLUDE_LABEL_PARAM,
  boardHomeSearch,
  removeAxisValueSearch,
} from "@/components/board/board-filter-params"

interface BoardFilterChipsProps {
  workspaceId: string
}

/**
 * The board-mode "Filtering the board" block (board-centered-sidebar-exploration.md
 * § V1). One chip per active include/exclude across the stream, type, and label
 * axes; each chip's X removes just that entry through the URL-vocabulary SSOT.
 * "Clear" returns to the lens base and "Save view" bookmarks the live selection
 * via the shared save dialog. The whole block only mounts when something is
 * filtered (the sidebar gates it), so success is silent (INV-63) — the chips are
 * the feedback.
 */
export function BoardFilterChips({ workspaceId }: BoardFilterChipsProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [saveOpen, setSaveOpen] = useState(false)

  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const labels = useWorkspaceLabels(workspaceId)
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
  const streamById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])

  const { selection } = useBoardSelection()

  const remove = (param: string, value: string) =>
    navigate(`${location.pathname}${removeAxisValueSearch(location.search, param, value)}`)

  const streamName = (id: string) => resolveStreamName(id, { streams, users, dmPeers }, "sidebar") ?? "Unknown stream"
  const labelName = (id: string) => labelById.get(id)?.name ?? "Unknown label"
  const streamIcon = (id: string) => STREAM_ICONS[streamById.get(id)?.type ?? "channel"] ?? Layers

  return (
    <div className="mb-2 rounded-lg border border-sidebar-border bg-sidebar-accent/30 p-2">
      <h3 className="m-0 px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Filtering the board
      </h3>
      <div className="flex flex-wrap items-center gap-1">
        {selection.scopeStreamIds.map((id) => (
          <FilterChip
            key={`in-${id}`}
            icon={streamIcon(id)}
            label={streamName(id)}
            onRemove={() => remove(BOARD_SCOPE_PARAM, id)}
            removeLabel={`Remove ${streamName(id)} from the board scope`}
          />
        ))}
        {selection.excludeStreamIds.map((id) => (
          <FilterChip
            key={`not-in-${id}`}
            icon={streamIcon(id)}
            label={streamName(id)}
            excluded
            onRemove={() => remove(BOARD_EXCLUDE_SCOPE_PARAM, id)}
            removeLabel={`Stop excluding ${streamName(id)} from the board`}
          />
        ))}
        {selection.scopeStreamTypes.map((type) => (
          <FilterChip
            key={`is-${type}`}
            icon={STREAM_ICONS[type] ?? Layers}
            label={BOARD_STREAM_TYPE_LABELS[type]}
            onRemove={() => remove(BOARD_TYPE_PARAM, type)}
            removeLabel={`Remove ${BOARD_STREAM_TYPE_LABELS[type]} from the board scope`}
          />
        ))}
        {selection.excludeStreamTypes.map((type) => (
          <FilterChip
            key={`not-is-${type}`}
            icon={STREAM_ICONS[type] ?? Layers}
            label={BOARD_STREAM_TYPE_LABELS[type]}
            excluded
            onRemove={() => remove(BOARD_EXCLUDE_TYPE_PARAM, type)}
            removeLabel={`Stop excluding ${BOARD_STREAM_TYPE_LABELS[type]} from the board`}
          />
        ))}
        {selection.scopeLabelIds.map((id) => (
          <FilterChip
            key={`label-${id}`}
            icon={Tag}
            label={labelName(id)}
            swatch={labelById.get(id)?.color}
            onRemove={() => remove(BOARD_LABEL_PARAM, id)}
            removeLabel={`Remove the ${labelName(id)} label from the board scope`}
          />
        ))}
        {selection.excludeLabelIds.map((id) => (
          <FilterChip
            key={`not-label-${id}`}
            icon={Tag}
            label={labelName(id)}
            swatch={labelById.get(id)?.color}
            excluded
            onRemove={() => remove(BOARD_EXCLUDE_LABEL_PARAM, id)}
            removeLabel={`Stop excluding the ${labelName(id)} label from the board`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-3 px-1">
        <Link
          to={`${location.pathname}${boardHomeSearch(location.search)}`}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Clear
        </Link>
        <button
          type="button"
          onClick={() => setSaveOpen(true)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          Save view
        </button>
      </div>
      {saveOpen && (
        <SaveCurrentViewDialog workspaceId={workspaceId} open onOpenChange={setSaveOpen} selection={selection} />
      )}
    </div>
  )
}
