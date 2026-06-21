import { useEffect, useState } from "react"

export interface PageActivityState {
  isVisible: boolean
  isFocused: boolean
  isActive: boolean
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
    isActive: isVisible && isFocused,
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

  return { isVisible, isFocused, isActive: isVisible && isFocused }
}
