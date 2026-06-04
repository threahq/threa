import type { ComponentProps, MouseEvent, ReactNode } from "react"
import { type LucideIcon, MoreHorizontal } from "lucide-react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { RelativeTime } from "@/components/relative-time"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/contexts"
import { cn } from "@/lib/utils"

export interface SidebarActionItem {
  id: string
  label: string
  icon: LucideIcon
  /** Emoji glyph rendered in place of `icon` (e.g. the user's current status). */
  emoji?: string | null
  /** Optional muted second line under the label (e.g. "Clears in 2 hours"). */
  description?: string | null
  href?: string
  onSelect?: () => void | Promise<void>
  variant?: "default" | "destructive"
  separatorBefore?: boolean
}

export interface SidebarActionPreview {
  streamName: string
  authorName?: string
  content: string
  createdAt?: string
}

interface SidebarActionMenuProps {
  actions: SidebarActionItem[]
  trigger?: ReactNode
  ariaLabel?: string
  align?: ComponentProps<typeof DropdownMenuContent>["align"]
  side?: ComponentProps<typeof DropdownMenuContent>["side"]
  contentClassName?: string
  /** Non-item node rendered at the top of the menu (e.g. an identity/status card). */
  header?: ReactNode
  /** Controlled open state — omit for Radix's uncontrolled behavior. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

async function runSidebarAction(action: SidebarActionItem) {
  if (!action.onSelect) return

  try {
    await action.onSelect()
  } catch (error) {
    console.error(`Sidebar action "${action.id}" failed:`, error)
    toast.error(error instanceof Error ? error.message : `Failed to complete ${action.label.toLowerCase()}`)
  }
}

function SidebarActionContent({ action, iconClassName }: { action: SidebarActionItem; iconClassName: string }) {
  const Icon = action.icon

  return (
    <>
      {action.emoji ? (
        <span
          className={cn(iconClassName, "inline-flex items-center justify-center text-base leading-none")}
          aria-hidden
        >
          {action.emoji}
        </span>
      ) : (
        <Icon className={iconClassName} />
      )}
      {action.description ? (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{action.label}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{action.description}</span>
        </span>
      ) : (
        <span>{action.label}</span>
      )}
    </>
  )
}

function SidebarActionMenuEntry({ action }: { action: SidebarActionItem }) {
  const isDestructive = action.variant === "destructive"
  const content = <SidebarActionContent action={action} iconClassName="mr-2 h-4 w-4" />

  return (
    <div>
      {action.separatorBefore && <DropdownMenuSeparator />}
      {action.href ? (
        <DropdownMenuItem asChild className={cn(isDestructive && "text-destructive focus:text-destructive")}>
          <Link
            to={action.href}
            onClick={() => {
              void runSidebarAction(action)
            }}
          >
            {content}
          </Link>
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          className={cn(isDestructive && "text-destructive focus:text-destructive")}
          onSelect={() => {
            void runSidebarAction(action)
          }}
        >
          {content}
        </DropdownMenuItem>
      )}
    </div>
  )
}

export function SidebarActionMenu({
  actions,
  trigger,
  ariaLabel = "Sidebar actions",
  align = "end",
  side,
  contentClassName,
  header,
  open,
  onOpenChange,
}: SidebarActionMenuProps) {
  const { setMenuOpen } = useSidebar()

  if (actions.length === 0 && !header) return null

  const defaultTrigger = (
    <Button
      variant="ghost"
      size="icon"
      className="absolute right-1 top-1 hidden h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 sm:flex"
      aria-label={ariaLabel}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <MoreHorizontal className="h-3.5 w-3.5" />
    </Button>
  )

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setMenuOpen(next)
        onOpenChange?.(next)
      }}
    >
      <DropdownMenuTrigger asChild>{trigger ?? defaultTrigger}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className={cn("w-40", contentClassName)}>
        {header}
        {actions.map((action) => (
          <SidebarActionMenuEntry key={action.id} action={action} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface SidebarActionDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: SidebarActionItem[]
  title?: string
  description?: string
  header?: ReactNode
  preview?: SidebarActionPreview | null
}

export function SidebarActionDrawer({
  open,
  onOpenChange,
  actions,
  title = "Sidebar actions",
  description = "Choose an action.",
  header,
  preview,
}: SidebarActionDrawerProps) {
  const hasVisibleContent = actions.length > 0 || preview != null || header != null

  if (!open && !hasVisibleContent) return null

  const resolvedHeader =
    header ??
    (preview ? (
      <div className="px-4 pt-1 pb-3">
        <div className="rounded-xl bg-muted/60 px-3.5 py-2.5">
          <p className="mb-1 text-sm font-medium text-foreground">{preview.streamName}</p>
          {(preview.authorName || preview.createdAt) && (
            <div className="mb-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
              {preview.authorName && <span className="truncate">{preview.authorName}</span>}
              {preview.authorName && preview.createdAt && <span className="text-muted-foreground/50">·</span>}
              {preview.createdAt && <RelativeTime date={preview.createdAt} className="shrink-0" />}
            </div>
          )}
          <p className="line-clamp-3 text-sm leading-snug text-foreground/80">{preview.content}</p>
        </div>
      </div>
    ) : null)

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh]">
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{description}</DrawerDescription>

        {resolvedHeader}

        {actions.length > 0 && (
          <div className="px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
            {actions.map((action) => (
              <SidebarActionDrawerEntry
                key={action.id}
                action={action}
                onClose={() => {
                  onOpenChange(false)
                }}
              />
            ))}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}

function SidebarActionDrawerEntry({ action, onClose }: { action: SidebarActionItem; onClose: () => void }) {
  const isDestructive = action.variant === "destructive"
  const className = cn(
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
    isDestructive ? "text-destructive active:bg-destructive/10" : "active:bg-muted/80"
  )
  const content = (
    <SidebarActionContent
      action={action}
      iconClassName={cn("h-[18px] w-[18px] shrink-0", isDestructive ? "text-destructive" : "text-muted-foreground")}
    />
  )

  return (
    <div>
      {action.separatorBefore && <Divider />}
      {action.href ? (
        <Link
          to={action.href}
          className={className}
          onClick={() => {
            onClose()
            void runSidebarAction(action)
          }}
        >
          {content}
        </Link>
      ) : (
        <button
          type="button"
          className={className}
          onClick={() => {
            onClose()
            void runSidebarAction(action)
          }}
        >
          {content}
        </button>
      )}
    </div>
  )
}

function Divider() {
  return <Separator className="mx-3 my-1 bg-border/50" />
}
