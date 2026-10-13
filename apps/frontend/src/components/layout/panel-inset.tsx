import { useLayoutEffect } from "react"
import { PANE_TRANSITION_MS } from "@/components/panes"

/**
 * Publish the width docked at the right edge as `--panel-inset-right`, and
 * whether its change animates.
 */
export function usePanelInset(insetRight: number, insetAnimates: boolean) {
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty("--panel-inset-right", `${insetRight}px`)
    root.style.setProperty("--panel-inset-duration", insetAnimates ? `${PANE_TRANSITION_MS}ms` : "0ms")
  }, [insetRight, insetAnimates])

  // A layout-effect cleanup, not a passive one: routes that each mount their own
  // owner swap instances within a single commit, and React runs every layout
  // teardown before any layout setup — so the outgoing reset lands before the
  // incoming write. As a passive cleanup it would run after paint and blank the
  // inset the new owner had just published.
  useLayoutEffect(
    () => () => {
      const root = document.documentElement
      root.style.setProperty("--panel-inset-right", "0px")
      root.style.setProperty("--panel-inset-duration", "0ms")
    },
    []
  )
}
