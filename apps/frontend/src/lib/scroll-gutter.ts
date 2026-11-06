const CSS_VAR = "--scrollbar-gutter"

/**
 * Publishes the width a classic scrollbar takes as `--scrollbar-gutter` on `:root`: 12px under the
 * `(pointer: fine)` styling in `index.css`, 0 where scrollbars overlay content (phones, macOS defaults).
 * Timeline scrollers reserve that gutter (`scrollbar-gutter: stable`), so their centered column sits half
 * a gutter left of the pane's center; overlays laid over the pane, like the floating composer, inset by it
 * to share the column. Measured, not hard-coded, because Firefox's `scrollbar-width: thin` and OS settings
 * decide the real width. The probe reserves its gutter the way the scrollers do, since a bare
 * `overflow: scroll` box can report no scrollbar when nothing overflows. It stays mounted and observed:
 * its content box shrinks by the gutter, so the variable follows the stylesheet landing after boot and a
 * `(pointer: fine)` flip.
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
