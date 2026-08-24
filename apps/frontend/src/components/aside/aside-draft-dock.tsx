import { useCallback, useState } from "react"
import { FileText, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/lib/dates"
import { newAsideDraftScope } from "@/lib/drafts/aside-scope"
import { useAsideDrafts } from "./use-aside-drafts"

interface AsideDraftDockProps {
  workspaceId: string
  asideId: string
  /** Open a draft for writing; the pane owns the editor surface. */
  onOpenDraft: (scope: string) => void
  /** The draft currently open, so the dock marks it. */
  openScope: string | null
}

/**
 * The aside's drafts: what you are writing here, as opposed to what you are
 * saying to Ariadne. Several can live at once, so the dock is a list rather
 * than one slot; each row is its own draft scope.
 */
export function AsideDraftDock({ workspaceId, asideId, onOpenDraft, openScope }: AsideDraftDockProps) {
  const drafts = useAsideDrafts(workspaceId, asideId)
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? drafts : drafts.slice(0, 3)

  const handleNew = useCallback(() => onOpenDraft(newAsideDraftScope(asideId)), [asideId, onOpenDraft])

  const now = new Date()

  return (
    <div className="shrink-0 border-b px-3 py-2" data-testid="aside-draft-dock">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {drafts.length > 0 ? `Drafts · ${drafts.length}` : "Drafts"}
        </span>
        <span className="flex-1" />
        {drafts.length > 3 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Show fewer" : `Show all ${drafts.length}`}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 rounded-full bg-primary/10 px-2 text-[11px] font-medium text-primary hover:bg-primary/15 hover:text-primary"
          onClick={handleNew}
        >
          <Plus className="h-3 w-3" />
          New draft
        </Button>
      </div>
      {visible.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-px">
          {visible.map((draft) => (
            <li key={draft.id}>
              <button
                type="button"
                onClick={() => onOpenDraft(draft.scope)}
                data-draft-scope={draft.scope}
                aria-current={draft.scope === openScope ? "true" : undefined}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-snug transition-colors hover:bg-muted/60",
                  draft.scope === openScope && "bg-muted"
                )}
              >
                <FileText
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    draft.scope === openScope ? "text-primary" : "text-muted-foreground/70"
                  )}
                />
                <span className={cn("min-w-0 flex-1 truncate", draft.isEmpty && "text-muted-foreground")}>
                  {draft.isEmpty ? "Empty draft" : draft.preview}
                </span>
                {/* When it was last touched, so a stack of drafts is orderable
                    by eye — the same terse age the anchor row uses. */}
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                  {formatRelativeTime(new Date(draft.clientUpdatedAt), now, undefined, { terse: true })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
