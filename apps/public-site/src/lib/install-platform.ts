export const INSTALL_PLATFORMS = ["ios", "android", "chromium", "mac-safari", "firefox"] as const
export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number]

// iPadOS Safari sends a Macintosh user agent; touch points are the only tell.
// Every iOS browser installs through the Share sheet, so all of them map to
// "ios", and Edge/Opera carry "Chrome/" so they land on the Chromium steps.
export function detectInstallPlatform(userAgent: string, maxTouchPoints: number): InstallPlatform | null {
  const mac = /Macintosh/.test(userAgent)
  if (/iPhone|iPad|iPod/.test(userAgent) || (mac && maxTouchPoints > 1)) return "ios"
  if (/Android/.test(userAgent)) return "android"
  if (/Firefox\//.test(userAgent)) return "firefox"
  if (/Chrome\/|Edg\//.test(userAgent)) return "chromium"
  if (mac && /Safari\//.test(userAgent)) return "mac-safari"
  return null
}
