import type { UserPreferences } from "@threa/types"

/**
 * Applies user preferences to the DOM.
 * Called on initial load and whenever preferences change.
 */
export function applyPreferencesToDOM(prefs: UserPreferences) {
  const root = document.documentElement

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && prefersDark)
  root.classList.toggle("dark", dark)

  root.dataset.messageDisplay = prefs.messageDisplay

  root.classList.toggle("reduced-motion", prefs.accessibility.reducedMotion)
  root.classList.toggle("high-contrast", prefs.accessibility.highContrast)
  root.dataset.fontSize = prefs.accessibility.fontSize
  root.dataset.fontFamily = prefs.accessibility.fontFamily
}

/**
 * Gets the resolved theme (light or dark) based on preferences and system settings.
 */
export function getResolvedTheme(theme: UserPreferences["theme"]): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }
  return theme
}
