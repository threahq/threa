import { useCallback, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { MoreHorizontal, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useInputMode, useTouchCapable } from "@/hooks"
import { useLongPress } from "@/hooks/use-long-press"
import { cn } from "@/lib/utils"

export interface TimelineCardAction {
  id: string
  label: string
  icon: LucideIcon
  href?: string
  onSelect?: () => void | Promise<void>
  variant?: "default" | "destructive"
  separatorBefore?: boolean
  disabled?: boolean
  disabledReason?: string
  loading?: boolean
  /** Show as an icon in the desktop hover toolbar before the overflow menu. */
  quick?: boolean
}

async function runTimelineCardAction(action: TimelineCardAction) {
  if (!action.onSelect || action.disabled) return

  try {
    await action.onSelect()
  } catch (error) {
    console.error(`Timeline card action "${action.id}" failed:`, error)
    toast.error(error instanceof Error ? error.message : `Failed to complete ${action.label.toLowerCase()}`)
  }
}

function ActionContent({ action, iconClassName }: { action: TimelineCardAction; iconClassName: string }) {
  const Icon = action.icon
  return (
    <>
      <Icon className={cn(iconClassName, action.loading && "animate-spin")} aria-hidden="true" />
      <span className="flex min-w-0 flex-col">
        <span>{action.label}</span>
        {action.disabledReason && (
          <span className="text-xs font-normal text-muted-foreground">{action.disabledReason}</span>
        )}
      </span>
    </>
  )
}

function DropdownAction({ action, onClose }: { action: TimelineCardAction; onClose?: () => void }) {
  const destructive = action.variant === "destructive"
  const className = cn("gap-2", destructive && "text-destructive focus:text-destructive")
  const content = (
    <ActionContent
      action={action}
      iconClassName={cn("h-4 w-4", destructive ? "text-destructive" : "text-muted-foreground")}
    />
  )

  return (
    <>
      {action.separatorBefore && <DropdownMenuSeparator />}
      {action.href ? (
        <DropdownMenuItem asChild disabled={action.disabled} className={className}>
          <Link to={action.href} onClick={onClose}>
            {content}
          </Link>
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          disabled={action.disabled}
          className={className}
          onSelect={() => {
            onClose?.()
            void runTimelineCardAction(action)
          }}
        >
          {content}
        </DropdownMenuItem>
      )}
    </>
  )
}

export function TimelineCardActionMenu({ actions }: { actions: TimelineCardAction[] }) {
  const [open, setOpen] = useState(false)
  if (actions.length === 0) return null

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground shadow-sm hover:border-primary/30"
          aria-label="Card actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        {actions.map((action) => (
          <DropdownAction key={action.id} action={action} onClose={() => setOpen(false)} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ContextAction({ action }: { action: TimelineCardAction }) {
  const destructive = action.variant === "destructive"
  const className = cn("gap-2", destructive && "text-destructive focus:text-destructive")
  const content = (
    <ActionContent
      action={action}
      iconClassName={cn("h-4 w-4", destructive ? "text-destructive" : "text-muted-foreground")}
    />
  )

  return (
    <>
      {action.separatorBefore && <ContextMenuSeparator />}
      {action.href ? (
        <ContextMenuItem asChild disabled={action.disabled} className={className}>
          <Link to={action.href}>{content}</Link>
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          disabled={action.disabled}
          className={className}
          onSelect={() => void runTimelineCardAction(action)}
        >
          {content}
        </ContextMenuItem>
      )}
    </>
  )
}

export function TimelineCardContextMenu({
  actions,
  disabled,
  children,
}: {
  actions: TimelineCardAction[]
  disabled?: boolean
  children: ReactNode
}) {
  if (disabled || actions.length === 0) return <>{children}</>

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[220px]">
        {actions.map((action) => (
          <ContextAction key={action.id} action={action} />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function DrawerAction({ action, onClose }: { action: TimelineCardAction; onClose: () => void }) {
  const destructive = action.variant === "destructive"
  const className = cn(
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
    destructive ? "text-destructive active:bg-destructive/10" : "active:bg-muted/80",
    action.disabled && "cursor-default opacity-50"
  )
  const content = (
    <ActionContent
      action={action}
      iconClassName={cn("h-[18px] w-[18px] shrink-0", destructive ? "text-destructive" : "text-muted-foreground")}
    />
  )

  const handleAction = () => {
    if (action.disabled) return
    onClose()
    void runTimelineCardAction(action)
  }

  return (
    <>
      {action.separatorBefore && <Separator className="mx-3 my-1 bg-border/50" />}
      {action.href ? (
        <Link to={action.href} className={className} aria-disabled={action.disabled} onClick={handleAction}>
          {content}
        </Link>
      ) : (
        <button type="button" className={className} disabled={action.disabled} onClick={handleAction}>
          {content}
        </button>
      )}
    </>
  )
}

export function TimelineCardActionDrawer({
  open,
  onOpenChange,
  actions,
  title,
  subtitle,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: TimelineCardAction[]
  title: string
  subtitle?: string
}) {
  if (!open && actions.length === 0) return null

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="flex max-h-[85dvh] min-h-0 flex-col">
        <DrawerTitle className="sr-only">Actions for {title}</DrawerTitle>
        <DrawerDescription className="sr-only">Choose an action for this card.</DrawerDescription>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-4 pb-3 pt-2">
            <p className="break-words text-base font-semibold text-foreground">{title}</p>
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <div className="px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
            {actions.map((action) => (
              <DrawerAction key={action.id} action={action} onClose={() => onOpenChange(false)} />
            ))}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function QuickAction({ action }: { action: TimelineCardAction }) {
  const Icon = action.icon
  const control = action.href ? (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
    >
      <Link to={action.href} aria-label={action.label}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </Button>
  ) : (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={action.disabled}
      className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={action.label}
      onClick={() => void runTimelineCardAction(action)}
    >
      <Icon className={cn("h-3.5 w-3.5", action.loading && "animate-spin")} aria-hidden="true" />
    </Button>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent>{action.disabledReason ?? action.label}</TooltipContent>
    </Tooltip>
  )
}

export function TimelineCardQuickActions({ actions }: { actions: TimelineCardAction[] }) {
  const quickActions = actions.filter((action) => action.quick)
  if (actions.length === 0) return null

  return (
    <TooltipProvider delayDuration={300}>
      <div className="reveal-actions-hover-only absolute right-4 top-0 z-10 -translate-y-1/2">
        <div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-popover/95 px-1 py-1 shadow-md backdrop-blur-sm">
          {quickActions.map((action) => (
            <span key={action.id} className="hidden sm:contents">
              <QuickAction action={action} />
            </span>
          ))}
          {/* Invisible for ordinary touch input, but still focusable: keyboard
              focus reveals this toolbar through `.reveal-actions-hover-only`,
              giving assistive input the same complete list as long-press. */}
          <TimelineCardActionMenu actions={actions} />
        </div>
      </div>
    </TooltipProvider>
  )
}

export function useTimelineCardActionSurface() {
  const touchCapable = useTouchCapable()
  const isTouchInput = useInputMode() === "touch"
  const [drawerOpen, setDrawerOpen] = useState(false)
  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const longPress = useLongPress({
    onLongPress: openDrawer,
    enabled: touchCapable,
    deferToNativeLinks: true,
    deferToInteractiveElements: true,
  })

  return {
    touchCapable,
    isTouchInput,
    drawerOpen,
    setDrawerOpen,
    longPress,
  }
}
