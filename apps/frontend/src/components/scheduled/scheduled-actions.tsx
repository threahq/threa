import { Pencil, Send, Trash2 } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ScheduledMessageView } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type ScheduledActionsVariant = "hover-cluster" | "drawer-list"

interface ScheduledActionsProps {
  scheduled: ScheduledMessageView
  /**
   * `hover-cluster` — small icon-only buttons for the desktop row (revealed
   * on hover via the parent's `group-hover` rule).
   * `drawer-list` — full-width labelled rows for the mobile bottom sheet.
   */
  variant: ScheduledActionsVariant
  onEdit?: (id: string) => void
  onSendNow?: (id: string) => void
  onCancel?: (id: string) => void
  /** Called after any action fires — drawer closes itself, hover cluster ignores it. */
  onAfterAction?: () => void
  className?: string
}

interface ActionDescriptor {
  key: "send-now" | "edit" | "cancel"
  icon: LucideIcon
  label: string
  /** Hover-cluster tooltip; defaults to `label`. */
  hoverLabel?: string
  destructive?: boolean
  onClick: () => void
}

/**
 * Single source of truth for the Send-now / Edit / Cancel triplet on
 * scheduled-message rows. The desktop hover-cluster, the mobile long-press
 * drawer, and the in-composer popover's drawer all render via this — keeping
 * gating ("pending → all three; failed → cancel-only", "Cancel" vs "Remove")
 * and icon vocabulary in one place.
 *
 * Callers wrap this in their own surface (the row's hover container, a
 * `<Drawer>`, etc.) — the component owns only the action list.
 */
export function ScheduledActions({
  scheduled,
  variant,
  onEdit,
  onSendNow,
  onCancel,
  onAfterAction,
  className,
}: ScheduledActionsProps) {
  const isPending = scheduled.status === "pending"
  const isFailed = scheduled.status === "failed"
  if (!isPending && !isFailed) return null

  const fire = (handler: ((id: string) => void) | undefined) => {
    if (!handler) return
    handler(scheduled.id)
    onAfterAction?.()
  }

  const actions: ActionDescriptor[] = []
  if (isPending && onSendNow) {
    actions.push({
      key: "send-now",
      icon: Send,
      label: "Send now",
      onClick: () => fire(onSendNow),
    })
  }
  if (isPending && onEdit) {
    actions.push({
      key: "edit",
      icon: Pencil,
      label: "Edit",
      onClick: () => fire(onEdit),
    })
  }
  if (onCancel) {
    actions.push({
      key: "cancel",
      icon: Trash2,
      label: isFailed ? "Remove" : "Cancel",
      destructive: true,
      onClick: () => fire(onCancel),
    })
  }

  if (actions.length === 0) return null

  if (variant === "drawer-list") {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        {actions.map((action) => (
          <Button
            key={action.key}
            variant="ghost"
            className={cn(
              "h-12 justify-start gap-3 text-base",
              action.destructive && "text-destructive hover:text-destructive"
            )}
            onClick={action.onClick}
          >
            <action.icon className="h-5 w-5" />
            {action.label}
          </Button>
        ))}
      </div>
    )
  }

  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      {actions.map((action) => (
        <Button
          key={action.key}
          size="icon"
          variant="ghost"
          className={cn("h-7 w-7", action.destructive && "text-muted-foreground hover:text-destructive")}
          onClick={action.onClick}
          title={action.hoverLabel ?? action.label}
        >
          <action.icon className="h-3.5 w-3.5" />
        </Button>
      ))}
    </div>
  )
}
