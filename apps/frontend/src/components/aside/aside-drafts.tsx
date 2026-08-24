import { ChevronDown, FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import { setAsideTrayExpanded, useAsideTrayExpanded } from "@/stores/aside-store"
import { ASIDE_META, ASIDE_TRAY } from "./aside-chrome"
import { AsideDraftStrip } from "./aside-draft-strip"
import { AsideDraftEditor } from "./aside-draft-editor"
import { useAsideDrafts } from "./use-aside-drafts"
import type { AsideDraftSurface } from "./use-aside-draft-surface"

interface AsideDraftTrayProps {
  workspaceId: string
  asideId: string
  surface: AsideDraftSurface
  className?: string
}

/**
 * The aside's drafts as a tray: a count with a chevron, folding to one line
 * the way the composer's attachment tray does, over the pills themselves.
 */
export function AsideDraftTray({ workspaceId, asideId, surface, className }: AsideDraftTrayProps) {
  const drafts = useAsideDrafts(workspaceId, asideId)
  const expanded = useAsideTrayExpanded(asideId)

  return (
    <div className={cn(ASIDE_TRAY, "flex-col gap-1.5", className)}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setAsideTrayExpanded(asideId, !expanded)}
        className="flex w-full items-center gap-1.5 rounded text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <FileText className="h-3 w-3 shrink-0" aria-hidden />
        <span className={ASIDE_META}>
          {drafts.length === 0 ? "No drafts" : `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}`}
        </span>
        <span className="flex-1" />
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <AsideDraftStrip
          drafts={drafts}
          openScope={surface.openScope}
          onOpen={surface.openDraft}
          onNew={surface.startDraft}
          onDelete={surface.discardDraft}
        />
      )}
    </div>
  )
}

interface AsideDraftsProps {
  workspaceId: string
  asideId: string
  surface: AsideDraftSurface
  className?: string
  /** The dragged split height, when a draft is open. */
  style?: React.CSSProperties
}

/**
 * What you are writing here, as opposed to what you are saying to Ariadne, on
 * a surface with room for both at once.
 *
 * Two things stacked, each carrying its own controls: the tray of drafts, and
 * — below it, so its controls sit against the thing they act on — the draft
 * currently open for writing.
 */
export function AsideDrafts({ workspaceId, asideId, surface, className, style }: AsideDraftsProps) {
  const drafts = useAsideDrafts(workspaceId, asideId)
  const open = surface.openScope

  return (
    <section
      data-testid="aside-drafts"
      data-open={open ? "true" : undefined}
      className={cn("flex min-h-0 flex-col", className)}
      style={style}
    >
      <AsideDraftTray workspaceId={workspaceId} asideId={asideId} surface={surface} />
      {open && (
        <AsideDraftEditor
          key={open}
          workspaceId={workspaceId}
          scope={open}
          title={drafts.find((draft) => draft.scope === open)?.preview}
          onClose={surface.closeDraft}
          onSendToComposer={surface.sendToComposer}
          pendingAgentBlocks={surface.pendingAgentBlocks}
          onPendingAgentBlocksConsumed={surface.consumePendingAgentBlocks}
        />
      )}
    </section>
  )
}
