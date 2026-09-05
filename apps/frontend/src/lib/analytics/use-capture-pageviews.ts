import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { capture } from "./posthog"

/**
 * The route shape rides along on posthog's own `$current_url`, which
 * `startAnalytics`'s `before_send` has already stripped of identifiers — so this
 * captures no path of its own and needs no route-pattern map.
 */
export function useCapturePageviews(): void {
  const { pathname } = useLocation()

  useEffect(() => {
    capture("$pageview")
  }, [pathname])
}
