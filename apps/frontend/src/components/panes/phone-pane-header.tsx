import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject, type TouchEvent } from "react"
import { Link } from "react-router-dom"
import { ChevronLeft, Layers2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { afterOverlayHistory } from "@/components/ui/history-back-close"
import { SidebarToggle } from "@/components/layout"
import { usePanel, usePanelTabFocusHandoff, usePhonePanes } from "@/contexts"
import { hasHorizontalScroll, OS_GESTURE_ZONE } from "@/hooks/use-sidebar-swipe"
import { cn } from "@/lib/utils"
import { usePaneCovered } from "./pane-host"
import { PanelTabTitle } from "./panel-tab-strip"

/** Horizontal travel that counts as a swipe (px). */
const SWIPE_DISTANCE = 40

/**
 * A phone pane's leading controls: the first pane in order keeps the sidebar
 * toggle, every other pane goes back (closes itself). Outside a phone's stacked
 * panes (the board) it keeps both.
 */
export function PhonePaneLeading({
  onBack,
  backRef,
}: {
  onBack: () => void
  backRef: RefObject<HTMLButtonElement | null>
}) {
  const phone = usePhonePanes()
  const { panelId } = usePanel()
  const first = phone !== null && phone.order[0] === panelId
  return (
    <>
      {(phone === null || first) && <SidebarToggle location="page" />}
      {!first && (
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onBack} ref={backRef}>
          <ChevronLeft className="h-4 w-4" />
          <span className="sr-only">Back</span>
        </Button>
      )}
    </>
  )
}

type SheetAction = { kind: "switch" | "close"; id: string }

/**
 * The layers button, its sheet of open panes, and the position segments along
 * the header's lower edge. The header must be `relative`.
 */
export function PhonePaneSwitcher({ workspaceId }: { workspaceId: string }) {
  const phone = usePhonePanes()
  const { panelId, getTabUrl, setCurrentPane, closeTab, canCloseTab } = usePanel()
  const [open, setOpen] = useState(false)
  const pending = useRef<SheetAction | null>(null)
  const rowId = useId()
  const covered = usePaneCovered()
  const focusHandoff = usePanelTabFocusHandoff()
  const layersRef = useRef<HTMLButtonElement>(null)
  const switched = useRef(false)

  useEffect(() => {
    if (open || !pending.current) return
    const { kind, id } = pending.current
    pending.current = null
    afterOverlayHistory(() => (kind === "switch" ? setCurrentPane(id) : closeTab(id)))
  }, [open, setCurrentPane, closeTab])

  // A switch leaves focus in a pane that goes inert behind the new one, so the new one takes it.
  useLayoutEffect(() => {
    if (!phone || covered || focusHandoff.current === null || focusHandoff.current !== panelId) return
    focusHandoff.current = null
    layersRef.current?.focus()
  }, [phone, covered, panelId, focusHandoff])

  if (!phone || phone.order.length < 2 || !panelId || !phone.order.includes(panelId)) return null
  const { order, current } = phone
  const choose = (action: SheetAction) => {
    pending.current = action
    switched.current = action.kind === "switch" && action.id !== current
    if (switched.current) focusHandoff.current = action.id
    setOpen(false)
  }

  return (
    <>
      <Button
        variant="ghost"
        className="h-8 shrink-0 gap-0.5 px-1.5"
        aria-label={`${order.length} open panes`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        ref={layersRef}
      >
        <Layers2 className="h-4 w-4" />
        <span className="text-xs tabular-nums">{order.length}</span>
      </Button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (switched.current) event.preventDefault()
            switched.current = false
          }}
        >
          <DrawerTitle className="sr-only">Open panes</DrawerTitle>
          <ul className="max-h-[60dvh] overflow-y-auto pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {order.map((id) => (
              <li key={id} className={cn("flex items-center", id === current && "bg-accent")}>
                <Link
                  to={getTabUrl(id)}
                  replace
                  aria-current={id === current ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault()
                    choose({ kind: "switch", id })
                  }}
                  className={cn(
                    "flex min-h-11 min-w-0 flex-1 items-center pl-4 text-sm",
                    id === current ? "font-semibold" : "text-muted-foreground"
                  )}
                >
                  <span id={`${rowId}-title-${id}`} className="truncate">
                    <PanelTabTitle workspaceId={workspaceId} panelId={id} />
                  </span>
                </Link>
                {canCloseTab(id) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    onClick={() => choose({ kind: "close", id })}
                    id={`${rowId}-close-${id}`}
                    aria-label="Close"
                    aria-labelledby={`${rowId}-close-${id} ${rowId}-title-${id}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </DrawerContent>
      </Drawer>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px flex h-0.5 gap-[3px] px-4">
        {order.map((id) => (
          <span
            key={id}
            data-pane-segment={id === current ? "current" : ""}
            className={cn("h-full flex-1 rounded-full", id === current ? "bg-primary" : "bg-border")}
          />
        ))}
      </div>
    </>
  )
}

/**
 * Touch handlers for a pane's header: a horizontal swipe steps to the previous
 * or next pane, without wrapping. A touch from a screen edge is the OS's back
 * or forward gesture, not a swipe. Empty outside a phone's stacked panes.
 */
export function usePhoneHeaderSwipe() {
  const phone = usePhonePanes()
  const { panelId, setCurrentPane } = usePanel()
  const start = useRef<{ x: number; y: number } | null>(null)
  const index = phone && panelId ? phone.order.indexOf(panelId) : -1
  if (!phone || phone.order.length < 2 || index === -1) return {}

  return {
    onTouchStart: (event: TouchEvent) => {
      const target = event.target as Element
      const touch = event.touches[0]
      const edge = touch.clientX < OS_GESTURE_ZONE || touch.clientX > window.innerWidth - OS_GESTURE_ZONE
      start.current =
        event.touches.length === 1 &&
        !edge &&
        !target.closest("input, textarea, [contenteditable]") &&
        !hasHorizontalScroll(target)
          ? { x: touch.clientX, y: touch.clientY }
          : null
    },
    onTouchEnd: (event: TouchEvent) => {
      const from = start.current
      start.current = null
      const touch = event.changedTouches[0]
      if (!from || !touch) return
      const dx = touch.clientX - from.x
      const dy = touch.clientY - from.y
      if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dy) >= Math.abs(dx)) return
      const next = phone.order[index + (dx < 0 ? 1 : -1)]
      if (next) setCurrentPane(next)
    },
    "data-pane-swipe-back": index > 0 || undefined,
  }
}
