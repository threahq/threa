import type { AsideSurface } from "@/stores/aside-store"

/**
 * The surface an aside opens into. Calls own the right edge: while one is
 * docked there, an aside that would dock opens fullscreen instead — there is
 * no parked state to fall back to, and the anchor row in the timeline is how
 * an aside is left and re-entered.
 */
export function resolveAsideOpenSurface(params: {
  remembered: AsideSurface | null
  callDocked: boolean
}): AsideSurface {
  const wanted = params.remembered ?? "dock"
  if (wanted === "dock" && params.callDocked) return "fullscreen"
  return wanted
}
