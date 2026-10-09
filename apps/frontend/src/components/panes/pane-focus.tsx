import { createContext, useContext, useEffect } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { usePanel, usePreferences } from "@/contexts"
import { Button } from "@/components/ui/button"
import { formatKeyBinding, getEffectiveKeyBinding } from "@/lib/keyboard-shortcuts"
import { isPinnedPagePane } from "@/lib/page-panes"
import { overlayOwnsEscape } from "@/lib/overlay-escape"

/** A section's place in the arrangement, as fractions of its width and height. */
export interface PaneMapCell {
  x: number
  y: number
  width: number
  height: number
  focused: boolean
}

export interface PaneFocus {
  /** The tabs floating over the rest, in layout order. */
  focused: readonly string[]
  map: readonly PaneMapCell[]
}

/** Provided where panes sit side by side, the only place a pane can float. */
export const PaneFocusContext = createContext<PaneFocus | null>(null)

/** Floats this tab's pane over the rest, or, while it floats, puts it back where the map shows. */
export function PaneFocusToggle() {
  const focus = useContext(PaneFocusContext)
  const { panelId, shownPanes, focusTab } = usePanel()
  const { preferences } = usePreferences()
  const floating = !!focus && !!panelId && focus.focused.includes(panelId)
  if (!focus || !panelId || ((shownPanes < 2 || isPinnedPagePane(panelId)) && !floating)) return null
  const binding = getEffectiveKeyBinding("togglePaneFocus", preferences?.keyboardShortcuts ?? {})

  if (!floating) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label="Focus pane"
        title={binding ? `Focus pane (${formatKeyBinding(binding)})` : "Focus pane"}
        onClick={() => focusTab(panelId)}
      >
        <Maximize2 className="h-4 w-4" />
      </Button>
    )
  }

  return (
    <Button
      variant="ghost"
      className="h-8 shrink-0 gap-1.5 px-2 text-muted-foreground"
      aria-label="Restore to layout"
      title={binding ? `Restore to layout (Esc, ${formatKeyBinding(binding)})` : "Restore to layout (Esc)"}
      onClick={() => focusTab(null)}
    >
      <svg viewBox="0 0 30 20" className="h-5 w-[30px]" aria-hidden>
        {focus.map.map((cell, index) => (
          <rect
            key={index}
            x={cell.x * 30 + 0.75}
            y={cell.y * 20 + 0.75}
            width={Math.max(cell.width * 30 - 1.5, 1)}
            height={Math.max(cell.height * 20 - 1.5, 1)}
            rx={1.5}
            className={cell.focused ? "fill-primary stroke-primary" : "fill-none stroke-current"}
            strokeWidth={1}
          />
        ))}
      </svg>
      <Minimize2 className="h-4 w-4" />
    </Button>
  )
}

/**
 * Escape puts a floating pane back. It runs before anything else on the page
 * listens, so the floating pane's own Escape (marking its stream read) waits
 * for the next press; a field, an open overlay, or anything outside the pane
 * with focus (the overview floating over it) keeps its Escape.
 */
export function usePaneFocusEscape(floating: boolean, restore: () => void) {
  useEffect(() => {
    if (!floating) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return
      if (target && target !== document.body && !target.closest("[data-focused-pane]")) return
      if (overlayOwnsEscape()) return
      event.preventDefault()
      event.stopPropagation()
      restore()
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [floating, restore])
}
