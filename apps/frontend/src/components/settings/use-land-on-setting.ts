import { useEffect } from "react"
import { settingAnchorId } from "./settings-registry"
import { scrollWithin } from "./scroll-within"

const HIGHLIGHT_MS = 2400
/** Rows behind a slow fetch or a permission check can mount this late and still be landed on. */
const LANDING_GIVE_UP_MS = 15_000

/** The OS setting or Threa's own Reduce motion, which the OS query can't see. */
export function prefersReducedMotion(): boolean {
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.classList.contains("reduced-motion")
  )
}

/**
 * Brings `?setting=` to the middle of `container`, the window's own scroll,
 * once its row has rendered — rows behind a fetch mount late — then
 * highlights it briefly and focuses it so a screen reader lands on the setting
 * the link named. `page` re-runs the landing when the same setting is named on
 * another page.
 */
export function useLandOnSetting(container: HTMLElement | null, page: string | null, setting: string | null) {
  useEffect(() => {
    if (!container || !page || !setting) return
    let highlighted: HTMLElement | null = null
    let clearTimer: ReturnType<typeof setTimeout> | undefined
    const land = (): boolean => {
      const row = container.querySelector<HTMLElement>(`#${CSS.escape(settingAnchorId(setting))}`)
      if (!row) return false
      scrollWithin(container, row, "center", prefersReducedMotion() ? "auto" : "smooth")
      row.focus({ preventScroll: true })
      row.dataset.highlighted = "true"
      highlighted = row
      clearTimer = setTimeout(() => row.removeAttribute("data-highlighted"), HIGHLIGHT_MS)
      return true
    }
    if (land()) return () => clearTimeout(clearTimer)
    const observer = new MutationObserver(() => {
      if (land()) observer.disconnect()
    })
    observer.observe(container, { childList: true, subtree: true })
    const giveUp = setTimeout(() => observer.disconnect(), LANDING_GIVE_UP_MS)
    return () => {
      observer.disconnect()
      clearTimeout(giveUp)
      clearTimeout(clearTimer)
      highlighted?.removeAttribute("data-highlighted")
    }
  }, [container, page, setting])
}
