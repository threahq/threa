import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject, type TouchEvent } from "react"
import { Link } from "react-router-dom"
import { ArrowUp, ChevronLeft, Layers2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { afterOverlayHistory } from "@/components/ui/history-back-close"
import { SidebarToggle } from "@/components/layout"
import { openedFrom } from "@/components/layout/sidebar/stream-pick"
import { usePanel, usePanelTabFocusHandoff, usePhonePanes } from "@/contexts"
import { hasHorizontalScroll, OS_GESTURE_ZONE } from "@/hooks/use-sidebar-swipe"
import { closePanelTab, followCurrentPanel, soleFirstPanelOf } from "@/lib/panel-tabs"
import { cn } from "@/lib/utils"
import { useStreamFromStore } from "@/stores/stream-store"
import { usePaneCovered } from "./pane-host"
import { PanelTabTitle } from "./panel-tab-strip"
import { PanelTabMenu, closeTabItems } from "./panel-tab-menu"

/** Horizontal travel that counts as a swipe (px). */
const SWIPE_DISTANCE = 40

const pickParent = (row: { parentStreamId?: string | null }) => ({ parentStreamId: row.parentStreamId ?? null })

/**
 * A phone pane's leading control: Up to the stream it was opened from (a thread's
 * parent, a draft's or overview's stream) where there is one, else the sidebar
 * toggle; the system's Back walks history. Outside a phone's stacked panes (the
 * board) it keeps the toggle and goes back by closing the pane.
 */
export function PhonePaneLeading({
  workspaceId,
  onBack,
  backRef,
}: {
  workspaceId: string
  onBack: () => void
  backRef: RefObject<HTMLButtonElement | null>
}) {
  const phone = usePhonePanes()
  const { panelId, openPanel } = usePanel()
  const parent = useStreamFromStore(workspaceId, panelId ?? undefined, pickParent)?.parentStreamId ?? null
  if (phone === null) {
    return (
      <>
        <SidebarToggle location="page" />
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onBack} ref={backRef}>
          <ChevronLeft className="h-4 w-4" />
          <span className="sr-only">Back</span>
        </Button>
      </>
    )
  }
  const up = panelId === null ? null : openedFrom(panelId, () => parent)
  if (up === null) return <SidebarToggle location="page" ref={backRef} />
  return (
    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => openPanel(up)} ref={backRef}>
      <ArrowUp className="h-4 w-4" />
      <span className="sr-only">Up</span>
    </Button>
  )
}

type SheetAction = { kind: "switch"; id: string } | { kind: "close"; ids: readonly string[] }

/**
 * The layers button, its sheet of open panes, and the position segments along
 * the header's lower edge. The header must be `relative`.
 */
export function PhonePaneSwitcher({ workspaceId }: { workspaceId: string }) {
  const phone = usePhonePanes()
  const { panelId, layout, getTabUrl, setCurrentPane, closeTabs, canCloseTab } = usePanel()
  const [open, setOpen] = useState(false)
  const pending = useRef<SheetAction | null>(null)
  const rowId = useId()
  const covered = usePaneCovered()
  const focusHandoff = usePanelTabFocusHandoff()
  const layersRef = useRef<HTMLButtonElement>(null)
  const switched = useRef(false)

  useEffect(() => {
    if (open || !pending.current) return
    const action = pending.current
    pending.current = null
    afterOverlayHistory(() => (action.kind === "switch" ? setCurrentPane(action.id) : closeTabs(action.ids)))
  }, [open, setCurrentPane, closeTabs])

  // A switch leaves focus in a pane that goes inert behind the new one, so the new one takes it.
  useLayoutEffect(() => {
    if (!phone || covered || focusHandoff.current === null || focusHandoff.current !== panelId) return
    focusHandoff.current = null
    layersRef.current?.focus()
  }, [phone, covered, panelId, focusHandoff])

  if (!phone || phone.order.length < 2 || !panelId || !phone.order.includes(panelId)) return null
  const { order, current } = phone
  const others = order.filter((id) => id !== current)
  const choose = (action: SheetAction) => {
    pending.current = action
    switched.current = action.kind === "switch" && action.id !== current
    if (action.kind === "switch" && switched.current) focusHandoff.current = action.id
    setOpen(false)
  }
  // The menu holds focus, and closing the current pane unmounts this button, so focus goes to the pane left on show.
  const closeFromMenu = (ids: readonly string[]) => {
    const next = ids.reduce(closePanelTab, layout)
    const after = followCurrentPanel(layout, next, current)
    focusHandoff.current = after === soleFirstPanelOf(next) ? null : after
    closeTabs(ids)
  }

  return (
    <>
      <PanelTabMenu
        items={[
          {
            id: "others",
            label: "Close others",
            disabled: !others.some(canCloseTab),
            onSelect: () => closeFromMenu(others),
          },
          { id: "all", label: "Close all", disabled: !order.some(canCloseTab), onSelect: () => closeFromMenu(order) },
        ]}
      >
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
      </PanelTabMenu>
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
              <PanelTabMenu
                key={id}
                items={closeTabItems({
                  ids: order,
                  id,
                  canClose: canCloseTab,
                  close: (ids) => choose({ kind: "close", ids }),
                  vertical: true,
                })}
              >
                <li className={cn("flex items-center", id === current && "bg-accent")}>
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
                      onClick={() => choose({ kind: "close", ids: [id] })}
                      id={`${rowId}-close-${id}`}
                      aria-label="Close"
                      aria-labelledby={`${rowId}-close-${id} ${rowId}-title-${id}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              </PanelTabMenu>
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
