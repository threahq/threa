import type { ComponentProps, MouseEvent, ReactNode, RefObject } from "react"
import { Check, ChevronDown, type LucideIcon, MoreHorizontal } from "lucide-react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { RelativeTime } from "@/components/relative-time"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/contexts"
import { groupVisibleActions } from "@/components/actions/action-model"
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
  /** Render `href` as a plain anchor opening in a new tab (cross-origin destinations). */
  external?: boolean
  onSelect?: () => void | Promise<void>
  variant?: "default" | "destructive"
  separatorBefore?: boolean
  /** Trailing checkmark — for entries that pick one of a set (theme, sort order). */
  checked?: boolean
  /**
   * Collapses adjacent same-`groupId` entries into one split row: the first is
   * the row itself, the rest sit behind its chevron (a sub-menu on desktop, a
   * dropdown on touch). Same grouping helper the message action menus use.
   */
  groupId?: string
}

export interface SidebarActionPreview {
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
      {action.checked && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
    </>
  )
}

function SidebarActionMenuEntry({ action }: { action: SidebarActionItem }) {
  return (
    <div>
      {action.separatorBefore && <DropdownMenuSeparator />}
      <SidebarActionMenuRow action={action} />
    </div>
  )
}

function SidebarActionMenuRow({
  action,
  className,
  onSelected,
}: {
  action: SidebarActionItem
  className?: string
  onSelected?: () => void
}) {
  const isDestructive = action.variant === "destructive"
  const content = <SidebarActionContent action={action} iconClassName="mr-2 h-4 w-4" />
  const itemClassName = cn(isDestructive && "text-destructive focus:text-destructive", className)
  // A `checked` entry picks one of a set, so the trailing glyph needs a state a
  // screen reader can read, not just a rendered checkmark.
  const checkedProps =
    action.checked === undefined ? {} : { role: "menuitemradio" as const, "aria-checked": action.checked }
  const run = () => {
    onSelected?.()
    void runSidebarAction(action)
  }

  let item: ReactNode
  if (action.href && action.external) {
    item = (
      <DropdownMenuItem asChild className={itemClassName} {...checkedProps}>
        <a href={action.href} target="_blank" rel="noreferrer" onClick={run}>
          {content}
        </a>
      </DropdownMenuItem>
    )
  } else if (action.href) {
    item = (
      <DropdownMenuItem asChild className={itemClassName} {...checkedProps}>
        <Link to={action.href} onClick={run}>
          {content}
        </Link>
      </DropdownMenuItem>
    )
  } else {
    item = (
      <DropdownMenuItem className={itemClassName} onSelect={run} {...checkedProps}>
        {content}
      </DropdownMenuItem>
    )
  }

  return item
}

/**
 * A split row: the group's first entry is the row itself, the rest sit behind a
 * chevron sub-menu. Mirrors the message action menu's split-button rows, over
 * this menu's own item type.
 */
function SidebarActionMenuGroup({ members }: { members: SidebarActionItem[] }) {
  const [primary, ...rest] = members
  return (
    <div>
      {primary.separatorBefore && <DropdownMenuSeparator />}
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">
          <SidebarActionMenuRow action={primary} className="rounded-r-none" />
        </div>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="cursor-pointer rounded-l-none border-l border-border/50 px-2 text-muted-foreground [&>svg]:rotate-90"
            aria-label={`${primary.label} options`}
          />
          <DropdownMenuSubContent sideOffset={4} alignOffset={-4}>
            {rest.map((member) => (
              <SidebarActionMenuRow key={member.id} action={member} />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </div>
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
      // Hidden on touch (long-press + right-click cover it there); mouse hover/
      // focus/open reveal via reveal-actions-hover-only. The host is the row's
      // `group relative` wrapper in stream-item / scratchpad-item.
      className="reveal-actions-hover-only absolute right-1 top-1 flex h-6 w-6"
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
        {groupVisibleActions(actions).map((item) =>
          item.kind === "single" ? (
            <SidebarActionMenuEntry key={item.action.id} action={item.action} />
          ) : (
            <SidebarActionMenuGroup key={item.members[0].id} members={item.members} />
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SidebarActionContextMenuEntry({ action }: { action: SidebarActionItem }) {
  const isDestructive = action.variant === "destructive"
  const content = <SidebarActionContent action={action} iconClassName="mr-2 h-4 w-4" />
  const itemClassName = cn(isDestructive && "text-destructive focus:text-destructive")

  let item: ReactNode
  if (action.href && action.external) {
    item = (
      <ContextMenuItem asChild className={itemClassName}>
        <a
          href={action.href}
          target="_blank"
          rel="noreferrer"
          onClick={() => {
            void runSidebarAction(action)
          }}
        >
          {content}
        </a>
      </ContextMenuItem>
    )
  } else if (action.href) {
    item = (
      <ContextMenuItem asChild className={itemClassName}>
        <Link
          to={action.href}
          onClick={() => {
            void runSidebarAction(action)
          }}
        >
          {content}
        </Link>
      </ContextMenuItem>
    )
  } else {
    item = (
      <ContextMenuItem
        className={itemClassName}
        onSelect={() => {
          void runSidebarAction(action)
        }}
      >
        {content}
      </ContextMenuItem>
    )
  }

  return (
    <div>
      {action.separatorBefore && <ContextMenuSeparator />}
      {item}
    </div>
  )
}

interface SidebarActionContextMenuProps {
  actions: SidebarActionItem[]
  children: ReactNode
  /**
   * Suppress the right-click menu. Used on mobile, where a long-press already
   * opens the {@link SidebarActionDrawer} — Radix's context menu would otherwise
   * hijack the same long-press gesture.
   */
  disabled?: boolean
  /**
   * The row's focusable element (its `<Link>`). On close Radix would otherwise
   * restore focus to the trigger — here a non-focusable wrapper `<div>` — which
   * drops focus to `<body>`. Returning it to the row keeps keyboard navigation
   * where the user left it.
   */
  focusRef?: RefObject<HTMLElement | null>
}

/**
 * Wraps a sidebar row so a desktop right-click opens the same actions exposed by
 * the hover "…" {@link SidebarActionMenu}. Both menus render the same
 * `SidebarActionItem[]`, so they never drift. Renders `children` untouched when
 * there are no actions or the menu is disabled.
 */
export function SidebarActionContextMenu({ actions, children, disabled, focusRef }: SidebarActionContextMenuProps) {
  const { setMenuOpen } = useSidebar()

  if (disabled || actions.length === 0) return <>{children}</>

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-40"
        onCloseAutoFocus={(event) => {
          const target = focusRef?.current
          if (!target) return
          event.preventDefault()
          target.focus()
        }}
      >
        {actions.map((action) => (
          <SidebarActionContextMenuEntry key={action.id} action={action} />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface SidebarActionDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: SidebarActionItem[]
  /** Full stream name shown as the drawer's visible title — wraps rather than truncating so long names stay readable on the cramped sidebar. */
  streamName?: string
  title?: string
  description?: string
  header?: ReactNode
  preview?: SidebarActionPreview | null
}

export function SidebarActionDrawer({
  open,
  onOpenChange,
  actions,
  streamName,
  title = "Sidebar actions",
  description = "Choose an action.",
  header,
  preview,
}: SidebarActionDrawerProps) {
  const hasVisibleContent = actions.length > 0 || preview != null || header != null || streamName != null

  if (!open && !hasVisibleContent) return null

  const resolvedHeader =
    header ??
    (preview ? (
      <div className="px-4 pt-1 pb-3">
        <div className="rounded-xl bg-muted/60 px-3.5 py-2.5">
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

        {/* min-h-0 so a tall header + action list scrolls within the 85dvh cap
            instead of overflowing past the sheet's bottom edge. */}
        <div className="min-h-0 overflow-y-auto">
          {streamName && (
            <div className="px-4 pt-2 pb-1">
              <p className="break-words text-base font-semibold text-foreground">{streamName}</p>
            </div>
          )}

          {resolvedHeader}

          {actions.length > 0 && (
            <div className="px-2 pb-[max(12px,env(safe-area-inset-bottom))]">
              {groupVisibleActions(actions).map((item) =>
                item.kind === "single" ? (
                  <SidebarActionDrawerEntry
                    key={item.action.id}
                    action={item.action}
                    onClose={() => {
                      onOpenChange(false)
                    }}
                  />
                ) : (
                  <SidebarActionDrawerGroup
                    key={item.members[0].id}
                    members={item.members}
                    onClose={() => {
                      onOpenChange(false)
                    }}
                  />
                )
              )}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function SidebarActionDrawerEntry({ action, onClose }: { action: SidebarActionItem; onClose: () => void }) {
  return (
    <div>
      {action.separatorBefore && <Divider />}
      <SidebarActionDrawerRow action={action} onClose={onClose} />
    </div>
  )
}

/** Split row on touch: the chevron opens the group's remaining entries. */
function SidebarActionDrawerGroup({ members, onClose }: { members: SidebarActionItem[]; onClose: () => void }) {
  const [primary, ...rest] = members
  return (
    <div>
      {primary.separatorBefore && <Divider />}
      <div className="flex items-stretch overflow-hidden rounded-lg">
        <div className="min-w-0 flex-1">
          <SidebarActionDrawerRow action={primary} onClose={onClose} className="rounded-none rounded-l-lg" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-10 shrink-0 items-center justify-center rounded-r-lg border-l border-border/50 text-muted-foreground transition-colors active:bg-muted/80"
              aria-label={`${primary.label} options`}
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-[220px]">
            {rest.map((member) => (
              <SidebarActionMenuRow key={member.id} action={member} onSelected={onClose} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

function SidebarActionDrawerRow({
  action,
  onClose,
  className: rowClassName,
}: {
  action: SidebarActionItem
  onClose: () => void
  className?: string
}) {
  const isDestructive = action.variant === "destructive"
  const className = cn(
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
    isDestructive ? "text-destructive active:bg-destructive/10" : "active:bg-muted/80",
    rowClassName
  )
  const content = (
    <SidebarActionContent
      action={action}
      iconClassName={cn("h-[18px] w-[18px] shrink-0", isDestructive ? "text-destructive" : "text-muted-foreground")}
    />
  )

  const handleClick = () => {
    onClose()
    void runSidebarAction(action)
  }

  let item: ReactNode
  if (action.href && action.external) {
    item = (
      <a href={action.href} target="_blank" rel="noreferrer" className={className} onClick={handleClick}>
        {content}
      </a>
    )
  } else if (action.href) {
    item = (
      <Link to={action.href} className={className} onClick={handleClick}>
        {content}
      </Link>
    )
  } else {
    item = (
      <button type="button" className={className} onClick={handleClick}>
        {content}
      </button>
    )
  }

  return item
}

function Divider() {
  return <Separator className="mx-3 my-1 bg-border/50" />
}
