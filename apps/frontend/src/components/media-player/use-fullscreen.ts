import { useCallback, useEffect, useState } from "react"

type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }

export interface Fullscreen {
  /** False when neither element fullscreen nor the native video fallback exists. */
  available: boolean
  active: boolean
  toggle(): void
}

/**
 * Element fullscreen on `root` keeps the player's own controls on screen.
 * Where only the video can go fullscreen (iPhone), that native presentation
 * is the fallback.
 */
export function useFullscreen(root: HTMLElement | null, video: HTMLVideoElement | null): Fullscreen {
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (!root) return
    const sync = () => setActive(document.fullscreenElement === root)
    document.addEventListener("fullscreenchange", sync)
    return () => {
      document.removeEventListener("fullscreenchange", sync)
      if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {})
    }
  }, [root])

  const elementCapable = !!root && document.fullscreenEnabled === true && typeof root.requestFullscreen === "function"
  const videoCapable = !!video && typeof (video as WebkitVideo).webkitEnterFullscreen === "function"

  const toggle = useCallback(() => {
    if (!root) return
    if (document.fullscreenElement === root) {
      void document.exitFullscreen().catch(() => {})
    } else if (elementCapable) {
      void root.requestFullscreen().catch(() => {})
    } else if (videoCapable) {
      ;(video as WebkitVideo).webkitEnterFullscreen?.()
    }
  }, [root, video, elementCapable, videoCapable])

  return { available: elementCapable || videoCapable, active, toggle }
}
