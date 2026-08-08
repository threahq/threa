import { useMemo, useState } from "react"
import { EllipsisVertical } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ActionDropdownItems } from "@/components/actions/action-dropdown-items"
import { groupVisibleActions } from "@/components/actions/action-model"
import { type DraftActionContext, getVisibleDraftActions } from "./draft-actions"

/**
 * Desktop dropdown for a drafts-explorer row — the drafts-side twin of
 * `MessageContextMenu`, rendering `draftActions` through the same
 * `ActionDropdownItems` body so wording, grouping and keyboard behavior match
 * the message surfaces.
 */
export function DraftContextMenu({ context, label }: { context: DraftActionContext; label: string }) {
  const [open, setOpen] = useState(false)
  const actions = getVisibleDraftActions(context)
  const groupedActions = useMemo(() => groupVisibleActions(actions), [actions])

  if (actions.length === 0) return null

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="reveal-actions-hover-only hidden h-7 w-7 shrink-0 text-muted-foreground sm:block"
          aria-label={`Draft actions: ${label}`}
        >
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <ActionDropdownItems items={groupedActions} context={context} onClose={() => setOpen(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
