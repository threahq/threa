import { useMemo, useRef, useState } from "react"
import type { SavedMessageView } from "@threahq/types"
import { EllipsisVertical } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ActionDropdownItems } from "@/components/actions/action-dropdown-items"
import {
  type MessageActionContext,
  type MessageAction,
  getVisibleActions,
  groupVisibleActions,
  resolveActionLabel,
} from "./message-actions"
import { ReminderPopoverContent } from "./reminder-popover-content"

interface MessageContextMenuProps {
  context: MessageActionContext
  saved?: SavedMessageView | null
  /** Drive the menu from outside (the ledger row opens it on right-click).
   *  Omitted ⇒ the trigger owns the state, as every existing caller expects. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function MessageContextMenu({ context, saved, open: openProp, onOpenChange }: MessageContextMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const restoreReminderFocus = useRef(false)
  const open = openProp ?? uncontrolledOpen
  const openRef = useRef(open)
  const menuGenerationRef = useRef(0)
  if (open && !openRef.current) menuGenerationRef.current++
  openRef.current = open
  const menuGeneration = menuGenerationRef.current
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const actions = getVisibleActions(context)
  const groupedActions = useMemo(
    () =>
      groupVisibleActions(
        actions.map((action) => (action.groupId === "save" ? { ...action, groupId: undefined } : action))
      ),
    [actions]
  )

  if (actions.length === 0) return null

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
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
        onEscapeKeyDown={() => {
          restoreReminderFocus.current = true
        }}
        // Selecting "Edit message" focuses the editor, so prevent Radix from stealing that focus.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (restoreReminderFocus.current) {
            restoreReminderFocus.current = false
            triggerRef.current?.focus()
          }
        }}
      >
        <ActionDropdownItems
          items={groupedActions}
          context={context}
          onClose={() => setOpen(false)}
          renderSubmenu={(action) => {
            if (action.id !== "set-reminder" || !context.workspaceId || !context.messageId) return null
            return (
              <ReminderActionSubmenu
                action={action}
                context={context}
                workspaceId={context.workspaceId}
                messageId={context.messageId}
                saved={saved ?? null}
                onReminderSet={() => {
                  if (!openRef.current || menuGenerationRef.current !== menuGeneration) return
                  restoreReminderFocus.current = true
                  setOpen(false)
                }}
                onEscape={() => {
                  restoreReminderFocus.current = true
                }}
              />
            )
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ReminderActionSubmenu({
  action,
  context,
  workspaceId,
  messageId,
  saved,
  onReminderSet,
  onEscape,
}: {
  action: MessageAction
  context: MessageActionContext
  workspaceId: string
  messageId: string
  saved: SavedMessageView | null
  onReminderSet: () => void
  onEscape: () => void
}) {
  const Icon = action.icon
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2 cursor-pointer">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {resolveActionLabel(action, context)}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-72 p-0"
        sideOffset={-8}
        onEscapeKeyDown={onEscape}
        // Keep Radix's menu focus handling from dismissing the inline editor or blocking Tab between its controls.
        onFocusOutside={(event) => event.preventDefault()}
        onKeyDownCapture={(event) => {
          if (event.key === "Tab" && (event.target as HTMLElement).closest('input, button, [role="combobox"]')) {
            event.stopPropagation()
          }
        }}
      >
        <ReminderPopoverContent
          workspaceId={workspaceId}
          messageId={messageId}
          conversationId={context.conversationId}
          saved={saved}
          menu
          onReminderSet={onReminderSet}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
