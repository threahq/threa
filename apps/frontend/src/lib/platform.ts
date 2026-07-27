/**
 * iOS/iPadOS WebKit, where backgrounding the page suspends the call outright.
 * iPadOS reports a desktop `MacIntel` platform, so touch points are the only
 * tell there.
 */
export function isIosWebKit(): boolean {
  if (typeof navigator === "undefined") return false
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return true
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1
}
