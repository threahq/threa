import { Fragment, useRef, type ReactElement } from "react"
import { Columns2, Rows2 } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { SidebarActionItem } from "@/components/layout/sidebar/sidebar-actions"
import { usePanel, usePanelTabFocusHandoff } from "@/contexts"
import { useContextMenuHoldGuard } from "@/hooks/use-context-menu-hold-guard"
import { tabsBeside, type SplitDirection, type TabsBeside } from "@/lib/panel-tabs"

export interface PanelTabMenuItem {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  separatorBefore?: boolean
}

export const SPLIT_LABELS: Record<SplitDirection, string> = { right: "Split right", down: "Split down" }

const FOCUSABLE = "a[href], button"

/**
 * Right-click (long-press on touch) menu over a tab, a tab row or a button that
 * stands for tabs. Focus returns to the trigger, or the first link or button in
 * it, unless a tab handoff is pending: then the tab left on show takes it.
 */
export function PanelTabMenu({ items, children }: { items: readonly PanelTabMenuItem[]; children: ReactElement }) {
  const focusHandoff = usePanelTabFocusHandoff()
  const holdGuard = useContextMenuHoldGuard()
  const triggerRef = useRef<HTMLElement>(null)
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        ref={triggerRef}
        onContextMenu={holdGuard.onContextMenu}
        className="select-none [-webkit-touch-callout:none]"
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-48"
        onPointerUpCapture={holdGuard.onPointerUpCapture}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (focusHandoff.current !== null) return
          const trigger = triggerRef.current
          const target = trigger?.matches(FOCUSABLE) ? trigger : trigger?.querySelector<HTMLElement>(FOCUSABLE)
          target?.focus()
        }}
      >
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore && <ContextMenuSeparator />}
            <ContextMenuItem disabled={item.disabled} onSelect={item.onSelect}>
              {item.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * Close, Close others, Close to either side and Close all, over `id` among
 * `ids`. A list read top to bottom closes above and below instead. An entry
 * with nothing it can close is disabled.
 */
export function closeTabItems({
  ids,
  id,
  canClose,
  close,
  vertical = false,
}: {
  ids: readonly string[]
  id: string
  canClose: (id: string) => boolean
  close: (ids: readonly string[]) => void
  vertical?: boolean
}): PanelTabMenuItem[] {
  const entry = (which: TabsBeside | "one", label: string): PanelTabMenuItem => {
    const set = which === "one" ? [id] : tabsBeside(ids, id, which)
    return { id: which, label, disabled: !set.some(canClose), onSelect: () => close(set) }
  }
  return [
    entry("one", "Close"),
    entry("others", "Close others"),
    entry("after", vertical ? "Close below" : "Close to the right"),
    entry("before", vertical ? "Close above" : "Close to the left"),
    entry("all", "Close all"),
  ]
}

/** Split right and Split down for a pane's own actions menu: the split-off tab's row takes focus in its new section. */
export function usePaneSplitActions(): SidebarActionItem[] {
  const { panelId, splits, splitTab } = usePanel()
  const focusHandoff = usePanelTabFocusHandoff()
  if (panelId === null) return []
  return splits.map((direction) => ({
    id: `split-${direction}`,
    label: SPLIT_LABELS[direction],
    icon: direction === "right" ? Columns2 : Rows2,
    onSelect: () => {
      focusHandoff.current = panelId
      splitTab(panelId, direction)
    },
  }))
}
