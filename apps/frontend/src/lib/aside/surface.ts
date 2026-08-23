import type { AsideSurface } from "@/stores/aside-store"

/**
 * The surface an aside opens into. Calls own the right edge: while a call is
 * docked there, an aside that would dock opens minimized (the strip above the
 * composer) instead, and an explicit open from the strip goes fullscreen.
 */
export function resolveAsideOpenSurface(params: {
  remembered: Exclude<AsideSurface, "minimized"> | null
  callDocked: boolean
}): AsideSurface {
  const wanted = params.remembered ?? "dock"
  if (wanted === "dock" && params.callDocked) return "minimized"
  return wanted
}

/** The surface a minimized aside restores into. */
export function resolveAsideRestoreSurface(params: {
  remembered: Exclude<AsideSurface, "minimized"> | null
  callDocked: boolean
}): Exclude<AsideSurface, "minimized"> {
  const wanted = params.remembered ?? "dock"
  if (wanted === "dock" && params.callDocked) return "fullscreen"
  return wanted
}
