import { useEffect, useState } from "react"

export interface PageActivityState {
  isVisible: boolean
  isFocused: boolean
  isActive: boolean
}

// Window focus only tells you which of several overlapping windows the user is
// working in — a desktop concern. On a touch device `document.hasFocus()` is an
// unreliable proxy for "the user is looking at this": mobile browsers and
// installed PWAs routinely report no focus while the page is the foreground, and
// the `focus` event frequently never fires when a PWA resumes from the
// background. So gate "active" on focus only when the primary pointer is fine
// (mouse/trackpad); on a coarse pointer (touch), a visible page is active.
function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false
}

function deriveIsActive(isVisible: boolean, isFocused: boolean): boolean {
  return isVisible && (isFocused || isCoarsePointer())
}

export function getPageActivityState(): PageActivityState {
  if (typeof document === "undefined") {
    return {
      isVisible: false,
      isFocused: false,
      isActive: false,
    }
  }

  const isVisible = document.visibilityState === "visible"
  const isFocused = document.hasFocus()

  return {
    isVisible,
    isFocused,
    isActive: deriveIsActive(isVisible, isFocused),
  }
}

export function usePageActivity(): PageActivityState {
  const initial = getPageActivityState()
  const [isVisible, setIsVisible] = useState(initial.isVisible)
  const [isFocused, setIsFocused] = useState(initial.isFocused)

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return

    const updateVisibility = () => setIsVisible(document.visibilityState === "visible")
    const updateFocus = () => setIsFocused(document.hasFocus())

    updateVisibility()
    updateFocus()

    document.addEventListener("visibilitychange", updateVisibility)
    window.addEventListener("focus", updateFocus)
    window.addEventListener("blur", updateFocus)

    return () => {
      document.removeEventListener("visibilitychange", updateVisibility)
      window.removeEventListener("focus", updateFocus)
      window.removeEventListener("blur", updateFocus)
    }
  }, [])

  return { isVisible, isFocused, isActive: deriveIsActive(isVisible, isFocused) }
}
