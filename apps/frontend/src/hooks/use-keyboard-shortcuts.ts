import { useEffect, useCallback, useRef } from "react"
import { usePreferences } from "@/contexts"
import {
  SHORTCUT_ACTIONS,
  matchesKeyBinding,
  getEffectiveKeyBinding,
  isSafeShortcutBinding,
} from "@/lib/keyboard-shortcuts"

type ShortcutHandlers = Partial<Record<string, () => void>>

/**
 * Register keyboard shortcut handlers, honoring user preferences for custom
 * key bindings.
 *
 * @param handlers - Map of action IDs to handler functions
 *
 * @example
 * ```tsx
 * useKeyboardShortcuts({
 *   openQuickSwitcher: () => setSwitcherOpen(true),
 *   openSearch: () => openSwitcher("search"),
 *   openCommands: () => openSwitcher("command"),
 * })
 * ```
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true) {
  const { preferences } = usePreferences()
  const customBindings = preferences?.keyboardShortcuts ?? {}

  // Use ref to avoid stale closure in event handler
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable

      for (const action of SHORTCUT_ACTIONS) {
        const handler = handlersRef.current[action.id]
        if (!handler) continue

        const binding = getEffectiveKeyBinding(action.id, customBindings)
        if (!binding || !isSafeShortcutBinding(binding)) continue

        // Skip non-global shortcuts when focus is in an input
        if (isInput && !action.global) continue

        if (matchesKeyBinding(event, binding)) {
          event.preventDefault()
          handler()
          return
        }
      }
    },
    [customBindings]
  )

  useEffect(() => {
    if (!enabled) return

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [enabled, handleKeyDown])
}
