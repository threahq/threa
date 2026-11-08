const CSS_VAR = "--scrollbar-gutter"

/**
 * Publishes the classic scrollbar width as `--scrollbar-gutter` on `:root` (0 where scrollbars overlay), so
 * overlays laid over a `scrollbar-gutter: stable` scroller, like the floating composer, share its column.
 * Measured because Firefox `scrollbar-width: thin` and OS settings decide the width. The probe reserves its
 * gutter like the scrollers, since a bare `overflow: scroll` box reports 0 in Chromium when nothing
 * overflows, and stays observed so the value follows a late stylesheet and `(pointer: fine)` flips.
 */
export function trackScrollbarGutter(): void {
  if (typeof document === "undefined") return
  const probe = document.createElement("div")
  probe.setAttribute("aria-hidden", "true")
  probe.style.cssText =
    "position:fixed;top:0;left:-200px;width:100px;height:50px;overflow-y:hidden;scrollbar-gutter:stable;visibility:hidden"
  document.body.appendChild(probe)
  new ResizeObserver(() => {
    document.documentElement.style.setProperty(CSS_VAR, `${probe.offsetWidth - probe.clientWidth}px`)
  }).observe(probe)
}
