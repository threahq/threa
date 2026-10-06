import { createContext, useContext, useEffect } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { usePanel, usePreferences } from "@/contexts"
import { Button } from "@/components/ui/button"
import { formatKeyBinding, getEffectiveKeyBinding } from "@/lib/keyboard-shortcuts"
import { overlayOwnsEscape } from "@/lib/overlay-escape"

/** A section's place in the arrangement, as fractions of its width and height. */
export interface PaneMapCell {
  x: number
  y: number
  width: number
  height: number
  focused: boolean
}

interface PaneFocus {
  /** The tab floating over the rest, or null. */
  focused: string | null
  map: readonly PaneMapCell[]
}

/** Provided where panes sit side by side, the only place a pane can float. */
export const PaneFocusContext = createContext<PaneFocus | null>(null)

/** Floats this tab's pane over the rest, or, while it floats, puts it back where the map shows. */
export function PaneFocusToggle() {
  const focus = useContext(PaneFocusContext)
  const { panelId, focusTab } = usePanel()
  const { preferences } = usePreferences()
  if (!focus || !panelId) return null

  if (focus.focused !== panelId) {
    const binding = getEffectiveKeyBinding("togglePaneFocus", preferences?.keyboardShortcuts ?? {})
    return (
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label="Focus"
        title={binding ? `Focus (${formatKeyBinding(binding)})` : "Focus"}
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
      title="Back to its place (Esc)"
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
 * for the next press; a field or an open overlay keeps its Escape.
 */
export function usePaneFocusEscape(focused: string | null, restore: () => void) {
  useEffect(() => {
    if (focused === null) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return
      if (overlayOwnsEscape()) return
      event.preventDefault()
      event.stopPropagation()
      restore()
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [focused, restore])
}
