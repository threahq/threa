import { useNavigate } from "react-router-dom"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"

/**
 * The stream `direction` rows away from the active one in sidebar order. An active
 * stream the sidebar doesn't show steps onto the first (down) or last (up) row;
 * the ends don't wrap.
 */
export function stepSidebarStream(order: string[], activeStreamId: string | undefined, direction: 1 | -1) {
  const index = activeStreamId ? order.indexOf(activeStreamId) : -1
  if (index === -1) return (direction === 1 ? order[0] : order[order.length - 1]) ?? null
  return order[index + direction] ?? null
}

interface SidebarStreamStepShortcutsProps {
  workspaceId: string
  /** Every visible stream id in render order. */
  order: string[]
  activeStreamId: string | undefined
}

/** Alt+Shift+↓/↑: open the next or previous stream in the sidebar's visible order. */
export function SidebarStreamStepShortcuts({ workspaceId, order, activeStreamId }: SidebarStreamStepShortcutsProps) {
  const navigate = useNavigate()
  const step = (direction: 1 | -1) => {
    const target = stepSidebarStream(order, activeStreamId, direction)
    if (target) navigate(`/w/${workspaceId}/s/${target}`)
  }

  useKeyboardShortcuts({
    sidebarNextStream: () => step(1),
    sidebarPreviousStream: () => step(-1),
  })

  return null
}
