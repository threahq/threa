import { useOptionalSettings, type SettingsLinkHistory } from "@/contexts/settings-context"

export type { SettingsLinkHistory }

const OUTSIDE_WINDOW: SettingsLinkHistory = {}

/** How a link in or into the settings window moves: it pushes, and from inside the window carries its depth. */
export function useSettingsLinkHistory(): SettingsLinkHistory {
  return useOptionalSettings()?.linkHistory ?? OUTSIDE_WINDOW
}
