import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import {
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Check,
  EllipsisVertical,
  EyeOff,
  Hash,
  Link2,
  Sparkles,
  type LucideIcon,
} from "lucide-react"
import type { SearchRefinement } from "@threahq/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { useLongPress } from "@/hooks/use-long-press"
import { useSaveMessage, useSavedForMessage } from "@/hooks/use-saved"
import { useTouchCapable } from "@/hooks/use-touch-capable"
import { cn } from "@/lib/utils"

/** How long the copied checkmark stands in for the link icon. */
const COPIED_FEEDBACK_MS = 1500
/** Window after a long press in which the synthetic click it produces is ignored. */
const SYNTHETIC_CLICK_SUPPRESS_MS = 700

export interface SearchRowMenuTarget {
  workspaceId: string
  /** What the row is, for the drawer's heading. */
  title: string
  /** Where the row itself navigates; also the link Copy link writes. */
  openHref: string
  openLabel: string
  streamId: string
  streamLabel: string
  /** The message Save for later saves; null on a row that matched on its topic or memos alone. */
  messageId: string | null
  /** Set on a row inside a conversation: More like this / Drop name it. */
  conversationId: string | null
  /** Absent while refining is unavailable (no query, or the search flag is off). */
  onRefine?: (refine: SearchRefinement) => void
}

interface RowMenuItem {
  id: string
  label: string
  icon: LucideIcon
  href?: string
  onSelect?: () => void
  /** Keeps the menu open so the item can confirm in place (INV-63). */
  keepOpen?: boolean
  separatorBefore?: boolean
  disabled?: boolean
}

export interface SearchRowMenuState {
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  /** Spread on the row: right-click for a mouse, long press for a finger. */
  rowHandlers: {
    onContextMenu: (event: React.MouseEvent) => void
    onClickCapture: (event: React.MouseEvent) => void
    onTouchStart?: (event: React.TouchEvent) => void
    onTouchMove?: (event: React.TouchEvent) => void
    onTouchEnd?: () => void
    onTouchCancel?: () => void
  }
}

/**
 * Opening state for one row's actions: the ⋮ dropdown and its right-click twin
 * for a mouse, the long-press drawer for a finger. The row owns the state so the
 * whole row is the gesture target, not just the button.
 */
export function useSearchRowMenu(): SearchRowMenuState {
  const touchCapable = useTouchCapable()
  const [menuOpen, setMenuOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // A time window, not a latch: a hold that produces no synthetic click (drawer
  // dismissed, touchcancel, scrolled away) must not swallow the next real tap.
  const suppressClicksUntilRef = useRef(0)
  const openDrawer = useCallback(() => {
    suppressClicksUntilRef.current = Date.now() + SYNTHETIC_CLICK_SUPPRESS_MS
    setDrawerOpen(true)
  }, [])
  const longPress = useLongPress({ onLongPress: openDrawer, enabled: touchCapable })

  // The row is a link, so the hold's synthetic click has to die before it
  // reaches the anchor — capture, not bubble.
  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (Date.now() >= suppressClicksUntilRef.current) return
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (touchCapable) {
        longPress.handlers.onContextMenu(event)
        return
      }
      event.preventDefault()
      setMenuOpen(true)
    },
    [touchCapable, longPress.handlers]
  )

  return {
    menuOpen,
    setMenuOpen,
    drawerOpen,
    setDrawerOpen,
    rowHandlers: {
      onContextMenu,
      onClickCapture,
      ...(touchCapable
        ? {
            onTouchStart: longPress.handlers.onTouchStart,
            onTouchMove: longPress.handlers.onTouchMove,
            onTouchEnd: longPress.handlers.onTouchEnd,
            onTouchCancel: longPress.handlers.onTouchCancel,
          }
        : {}),
    },
  }
}

/**
 * The actions of one result row, in two presentations over one list of items: a
 * dropdown behind the ⋮ (and the row's right-click) for a mouse, a bottom sheet
 * for a long press. Both carry every item.
 */
export function SearchRowMenu({
  target,
  state,
  className,
}: {
  target: SearchRowMenuTarget
  state: SearchRowMenuState
  className?: string
}) {
  const touchCapable = useTouchCapable()

  return (
    <>
      <div className={cn("reveal-actions-hover-only absolute z-10", className)}>
        <DropdownMenu open={state.menuOpen} onOpenChange={state.setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              aria-label="Row actions"
              className="h-6 w-6 shrink-0 bg-card text-muted-foreground shadow-sm hover:border-primary/30"
            >
              <EllipsisVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]" onCloseAutoFocus={(e) => e.preventDefault()}>
            <RowMenuDropdownItems target={target} onClose={() => state.setMenuOpen(false)} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {touchCapable && (
        <Drawer open={state.drawerOpen} onOpenChange={state.setDrawerOpen}>
          <DrawerContent className="max-h-[85dvh]">
            <DrawerTitle className="sr-only">Row actions</DrawerTitle>
            <div className="px-4 pb-2 pt-1">
              <p className="truncate rounded-xl bg-muted/60 px-3.5 py-2.5 text-[13px] font-medium text-muted-foreground">
                {target.title}
              </p>
            </div>
            <div
              data-vaul-no-drag
              className="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(12px,env(safe-area-inset-bottom))]"
            >
              <RowMenuDrawerItems target={target} onClose={() => state.setDrawerOpen(false)} />
            </div>
          </DrawerContent>
        </Drawer>
      )}
    </>
  )
}

function RowMenuDropdownItems({ target, onClose }: { target: SearchRowMenuTarget; onClose: () => void }) {
  const items = useRowMenuItems(target)

  return (
    <>
      {items.map((item) => (
        <div key={item.id} className="contents">
          {item.separatorBefore && <DropdownMenuSeparator />}
          {item.href ? (
            <DropdownMenuItem asChild>
              <Link to={item.href} onClick={onClose}>
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={item.disabled}
              onSelect={(event) => {
                if (item.keepOpen) event.preventDefault()
                item.onSelect?.()
              }}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </DropdownMenuItem>
          )}
        </div>
      ))}
    </>
  )
}

const DRAWER_ITEM_CLASS =
  "flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-[15px] text-foreground transition-colors active:bg-muted disabled:opacity-50"

function RowMenuDrawerItems({ target, onClose }: { target: SearchRowMenuTarget; onClose: () => void }) {
  const items = useRowMenuItems(target)

  return (
    <div className="flex flex-col">
      {items.map((item) =>
        item.href ? (
          <Link key={item.id} to={item.href} onClick={onClose} className={DRAWER_ITEM_CLASS}>
            <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            {item.label}
          </Link>
        ) : (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            className={DRAWER_ITEM_CLASS}
            onClick={() => {
              item.onSelect?.()
              if (!item.keepOpen) onClose()
            }}
          >
            <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

/**
 * The row's actions, declared once for both presentations. Only mounted while a
 * menu is open, so the saved lookup and the save mutation cost nothing per row.
 */
function useRowMenuItems(target: SearchRowMenuTarget): RowMenuItem[] {
  const { workspaceId, openHref, messageId, conversationId, onRefine } = target
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    },
    []
  )

  const saved = useSavedForMessage(workspaceId, messageId)
  const saveMessage = useSaveMessage(workspaceId)

  const copyLink = () => {
    void navigator.clipboard.writeText(`${window.location.origin}${openHref}`).then(
      () => {
        setCopied(true)
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
      },
      () => toast.error("Failed to copy link")
    )
  }

  const items: RowMenuItem[] = [{ id: "open", label: target.openLabel, icon: ArrowUpRight, href: openHref }]

  // Open lands on the matched message; this is the stream itself. Identical only
  // on a row with nothing to anchor to, and then it is not worth an item.
  const streamHref = `/w/${workspaceId}/s/${target.streamId}`
  if (streamHref !== openHref) {
    items.push({ id: "stream", label: `Show in ${target.streamLabel}`, icon: Hash, href: streamHref })
  }
  items.push({ id: "copy", label: "Copy link", icon: copied ? Check : Link2, onSelect: copyLink, keepOpen: true })

  const actions: RowMenuItem[] = []
  if (messageId) {
    actions.push({
      id: "save",
      label: saved ? "Saved" : "Save for later",
      icon: saved ? BookmarkCheck : Bookmark,
      disabled: Boolean(saved),
      onSelect: () =>
        saveMessage.mutate(
          { messageId, ...(conversationId ? { conversationId } : {}) },
          { onError: () => toast.error("Could not save message") }
        ),
    })
  }
  if (conversationId && onRefine) {
    actions.push(
      {
        id: "more",
        label: "More like this",
        icon: Sparkles,
        onSelect: () => onRefine({ kind: "more", conversationId }),
      },
      { id: "drop", label: "Drop", icon: EyeOff, onSelect: () => onRefine({ kind: "drop", conversationId }) }
    )
  }
  if (actions[0]) actions[0].separatorBefore = true

  return [...items, ...actions]
}
