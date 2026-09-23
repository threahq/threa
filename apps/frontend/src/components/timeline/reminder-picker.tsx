import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useInputMode } from "@/hooks/use-input-mode"
import type { SavedMessageView } from "@threahq/types"
import { ReminderPickerSheet } from "./reminder-picker-sheet"
import { ReminderPopoverContent } from "./reminder-popover-content"

interface ReminderPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRect: DOMRect | null
  workspaceId: string
  messageId: string | null
  conversationId?: string
  saved: SavedMessageView | null
}

export function ReminderPicker({ anchorRect, ...props }: ReminderPickerProps) {
  const isTouch = useInputMode() === "touch"
  if (isTouch) return <ReminderPickerSheet {...props} />

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      {anchorRect && <PopoverAnchor virtualRef={{ current: { getBoundingClientRect: () => anchorRect } }} />}
      <PopoverContent align="end" className="w-72 p-0" onCloseAutoFocus={(event) => event.preventDefault()}>
        <ReminderPopoverContent
          workspaceId={props.workspaceId}
          messageId={props.messageId}
          conversationId={props.conversationId}
          saved={props.saved}
          onReminderSet={() => props.onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

export function reminderAnchorRect(): DOMRect | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement.getBoundingClientRect() : null
}
