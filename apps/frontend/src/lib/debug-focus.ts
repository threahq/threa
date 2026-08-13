/**
 * TEMPORARY diagnostic for the mobile composer focus investigation
 * (PR #1880): with `?debugFocus` in the URL, focus traffic and the
 * composer's collapse decisions render in an on-screen overlay so a phone
 * screen recording shows the mechanism. Remove once the pill focus work
 * is verified on-device.
 */
export const DEBUG_FOCUS_LOG_EVENT = "threa:debug-focus-log"

export const debugFocusEnabled =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debugFocus")

export function debugFocusLog(message: string) {
  if (!debugFocusEnabled) return
  window.dispatchEvent(new CustomEvent(DEBUG_FOCUS_LOG_EVENT, { detail: message }))
}
