import { useMemo, useState } from "react"
import { EllipsisVertical } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ActionDropdownItems } from "@/components/actions/action-dropdown-items"
import { type MessageActionContext, getVisibleActions, groupVisibleActions } from "./message-actions"

interface MessageContextMenuProps {
  context: MessageActionContext
  /** Drive the menu from outside (the ledger row opens it on right-click).
   *  Omitted ⇒ the trigger owns the state, as every existing caller expects. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function MessageContextMenu({ context, open: openProp, onOpenChange }: MessageContextMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = openProp ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const actions = getVisibleActions(context)
  const groupedActions = useMemo(() => groupVisibleActions(actions), [actions])

  if (actions.length === 0) return null

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-6 w-6 shadow-sm hover:border-primary/30 text-muted-foreground shrink-0"
          aria-label="Message actions"
        >
          <EllipsisVertical className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[200px]"
        // Prevent Radix from restoring focus to the trigger button on close.
        // Without this, selecting "Edit message" focuses the editor via autoFocus,
        // then Radix's cleanup steals focus back to the trigger button.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <ActionDropdownItems items={groupedActions} context={context} onClose={() => setOpen(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
