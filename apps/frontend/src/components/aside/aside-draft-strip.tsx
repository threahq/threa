import { FileText, Plus } from "lucide-react"
import { AttachmentPill } from "@/components/composer/attachment-pill"
import { formatRelativeTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import type { AsideDraftRow } from "./use-aside-drafts"

interface AsideDraftStripProps {
  drafts: AsideDraftRow[]
  /** The draft currently open for writing, if any. */
  openScope: string | null
  onOpen: (scope: string) => void
  onNew: () => void
  onDelete: (scope: string) => void
}

/**
 * The aside's drafts as a tray of pills — the composer's attachment tray, in
 * the same primitive (`AttachmentPill`) and with the same manners: each one
 * names itself, says how old it is, carries its own ×, and the row WRAPS
 * rather than squeezing every pill into an unreadable stub in a narrow column. New-draft leads the tray rather than trailing it: trailing, it was
 * the first thing pushed past the scroll cap by the drafts it creates.
 */
export function AsideDraftStrip({ drafts, openScope, onOpen, onNew, onDelete }: AsideDraftStripProps) {
  const now = new Date()
  return (
    // Two pill rows plus a sliver of the third, then it scrolls — the same
    // cap the composer's attachment tray uses, for the same reason: the tray
    // must never eat the surface it sits on top of.
    <div className="flex max-h-[72px] min-w-0 flex-1 flex-wrap items-center gap-1.5 overflow-y-auto">
      <button
        type="button"
        aria-label={drafts.length === 0 ? "Start a draft" : "New draft"}
        onClick={() => onNew()}
        className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-dashed px-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary"
      >
        <Plus className="h-3 w-3" aria-hidden />
        {drafts.length === 0 && "Start a draft"}
      </button>
      {drafts.map((draft) => {
        const label = draft.isEmpty ? "Empty draft" : draft.preview
        const active = draft.scope === openScope
        return (
          <AttachmentPill
            key={draft.id}
            icon={FileText}
            label={label}
            labelMaxWidth="max-w-[150px]"
            secondary={formatRelativeTime(new Date(draft.clientUpdatedAt), now, undefined, { terse: true })}
            activateLabel={`Open draft: ${label}`}
            current={active}
            onActivate={() => onOpen(draft.scope)}
            removeLabel={`Delete draft: ${label}`}
            onRemove={() => onDelete(draft.scope)}
            className={cn(
              "h-7 max-w-full gap-1.5 px-2 text-[11px]",
              active ? "border-primary/50 bg-primary/10" : "border-border/70 text-muted-foreground"
            )}
          />
        )
      })}
    </div>
  )
}
