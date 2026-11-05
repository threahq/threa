import { useMemo } from "react"
import { useLocation } from "react-router-dom"
import { SETTINGS_DRILL_STATE } from "@/contexts/settings-context"

/** Where a link inside the settings window goes in history. */
export interface SettingsLinkHistory {
  replace: boolean
  state?: unknown
}

/** One column's index pushes the page it opens, so Back and close return through the index. */
export const DRILL_LINK_HISTORY: SettingsLinkHistory = { replace: false, state: SETTINGS_DRILL_STATE }

/**
 * Moving within the window replaces the entry and keeps its state: a page
 * drilled from the index stays drilled, so closing still pops past the index
 * instead of leaving it for Back to reopen.
 */
export function useInWindowLinkHistory(): SettingsLinkHistory {
  const { state } = useLocation()
  return useMemo(() => ({ replace: true, state }), [state])
}
