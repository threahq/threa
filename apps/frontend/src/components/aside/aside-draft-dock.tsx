import { useCallback, useState } from "react"
import { FileText, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
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

  return (
    <div className="shrink-0 border-b px-2 py-1.5" data-testid="aside-draft-dock">
      <div className="flex items-center gap-1">
        <span className="px-1 text-xs font-medium text-muted-foreground">
          {drafts.length > 0 ? `Drafts · ${drafts.length}` : "Drafts"}
        </span>
        <span className="flex-1" />
        {drafts.length > 3 && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? "Show fewer" : `Show all ${drafts.length}`}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={handleNew}>
          <Plus className="h-3.5 w-3.5" />
          New draft
        </Button>
      </div>
      {visible.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {visible.map((draft) => (
            <li key={draft.id}>
              <button
                type="button"
                onClick={() => onOpenDraft(draft.scope)}
                data-draft-scope={draft.scope}
                aria-current={draft.scope === openScope ? "true" : undefined}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted",
                  draft.scope === openScope && "bg-muted"
                )}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className={cn("min-w-0 truncate", draft.isEmpty && "text-muted-foreground")}>
                  {draft.isEmpty ? "Empty draft" : draft.preview}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
