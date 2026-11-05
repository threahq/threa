/**
 * Scrolls `container` alone, never the window or drawer around it, which
 * `scrollIntoView` would also move: "start" puts `target` at its top, clear of
 * the target's scroll margin; "center" centres it; "nearest" moves only as far
 * as it takes to show all of it.
 */
export function scrollWithin(
  container: HTMLElement,
  target: HTMLElement,
  block: "start" | "center" | "nearest",
  behavior: ScrollBehavior = "auto"
) {
  const bounds = container.getBoundingClientRect()
  const rect = target.getBoundingClientRect()
  const style = getComputedStyle(target)
  const above = rect.top - (parseFloat(style.scrollMarginTop) || 0) - bounds.top
  const below = rect.bottom + (parseFloat(style.scrollMarginBottom) || 0) - bounds.bottom
  let delta = above
  if (block === "center") delta = rect.top + rect.height / 2 - (bounds.top + bounds.height / 2)
  if (block === "nearest") {
    if (above >= 0 && below <= 0) return
    if (above >= 0) delta = Math.min(above, below)
  }
  if (Math.abs(delta) < 1) return
  container.scrollTo({ top: container.scrollTop + delta, behavior })
}
