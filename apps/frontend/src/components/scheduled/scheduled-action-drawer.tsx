import type { ScheduledMessageView } from "@threahq/types"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { stripMarkdownToInline } from "@/lib/markdown"
import { ScheduledActions } from "./scheduled-actions"

interface ScheduledActionDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scheduled: ScheduledMessageView
  onEdit?: (id: string) => void
  onSendNow?: (id: string) => void
  onCancel?: (id: string) => void
}

/**
 * Mobile action sheet opened via long-press on a scheduled-message row. The
 * preview header echoes the row content so the user knows which message
 * they're acting on; `ScheduledActions` renders the gated triplet.
 */
export function ScheduledActionDrawer({
  open,
  onOpenChange,
  scheduled,
  onEdit,
  onSendNow,
  onCancel,
}: ScheduledActionDrawerProps) {
  const previewText = stripMarkdownToInline(scheduled.contentMarkdown).trim() || "(empty)"
  const close = () => onOpenChange(false)

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[60dvh]">
        <DrawerTitle className="sr-only">Scheduled message actions</DrawerTitle>
        <div className="flex flex-col px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-1">
          <p className="line-clamp-2 text-sm text-muted-foreground">{previewText}</p>
          <ScheduledActions
            scheduled={scheduled}
            variant="drawer-list"
            onEdit={onEdit}
            onSendNow={onSendNow}
            onCancel={onCancel}
            onAfterAction={close}
            className="mt-3"
          />
        </div>
      </DrawerContent>
    </Drawer>
  )
}
