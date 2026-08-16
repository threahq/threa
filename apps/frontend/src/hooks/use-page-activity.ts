import { useEffect, useRef, useState } from "react"

export const INTERACTION_RESAMPLE_THROTTLE_MS = 1000

const INTERACTION_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const

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
  const lastInteractionResampleRef = useRef(0)

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return

    const updateVisibility = () => setIsVisible(document.visibilityState === "visible")
    const updateFocus = () => setIsFocused(document.hasFocus())
    const updatePageShow = () => {
      updateVisibility()
      updateFocus()
    }

    // Some mobile resumes fire none of the lifecycle events above, so live
    // interaction is the only reliable signal that the page is back.
    const resampleFromInteraction = () => {
      const now = Date.now()
      if (now - lastInteractionResampleRef.current < INTERACTION_RESAMPLE_THROTTLE_MS) return
      lastInteractionResampleRef.current = now
      updateVisibility()
      updateFocus()
    }

    updateVisibility()
    updateFocus()

    document.addEventListener("visibilitychange", updateVisibility)
    window.addEventListener("focus", updateFocus)
    window.addEventListener("blur", updateFocus)
    window.addEventListener("pageshow", updatePageShow)
    for (const type of INTERACTION_EVENTS) {
      window.addEventListener(type, resampleFromInteraction, { capture: true, passive: true })
    }

    return () => {
      document.removeEventListener("visibilitychange", updateVisibility)
      window.removeEventListener("focus", updateFocus)
      window.removeEventListener("blur", updateFocus)
      window.removeEventListener("pageshow", updatePageShow)
      for (const type of INTERACTION_EVENTS) {
        window.removeEventListener(type, resampleFromInteraction, { capture: true })
      }
    }
  }, [])

  return { isVisible, isFocused, isActive: isVisible && isFocused }
}
