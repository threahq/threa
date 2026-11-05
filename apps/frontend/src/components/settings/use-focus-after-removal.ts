import { useCallback, useLayoutEffect, useRef } from "react"

/** Marks the focusable element of each list item (such as its remove button). */
export const FOCUS_ITEM = { "data-focus-item": "" } as const
/** The list's stable control (its add field, filter or day switch), focused once no item is left. */
export const FOCUS_FALLBACK = { "data-focus-fallback": "" } as const
/** Bounds one list's items and its fallback. */
export const FOCUS_SCOPE = { "data-focus-scope": "" } as const

interface PendingRemoval {
  element: HTMLElement
  scope: HTMLElement
  index: number
}

/**
 * Removing a list item takes its focused control out of the page. Call the
 * returned function with that control (a {@link FOCUS_ITEM}) just before
 * removing it: once a render of this component drops it, focus moves to the
 * item that took its place, else the one before, else the scope's
 * {@link FOCUS_FALLBACK}. Removal may land a few renders later (a save), and
 * nothing moves if focus went elsewhere meanwhile.
 */
export function useFocusAfterRemoval(): (removed: HTMLElement) => void {
  const pending = useRef<PendingRemoval | null>(null)

  useLayoutEffect(() => {
    const removal = pending.current
    if (!removal || removal.element.isConnected) return
    pending.current = null
    const active = document.activeElement
    if (active && active !== document.body) return
    const items = [...removal.scope.querySelectorAll<HTMLElement>("[data-focus-item]")]
    const target =
      items[removal.index] ??
      items[removal.index - 1] ??
      removal.scope.querySelector<HTMLElement>("[data-focus-fallback]")
    target?.focus()
  })

  return useCallback((removed: HTMLElement) => {
    const scope = removed.closest<HTMLElement>("[data-focus-scope]")
    if (!scope) return
    const items = [...scope.querySelectorAll<HTMLElement>("[data-focus-item]")]
    pending.current = { element: removed, scope, index: items.indexOf(removed) }
  }, [])
}
