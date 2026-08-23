import { useEffect } from "react"
import { useWorkspaceStreams, useWorkspaceUnreadState } from "@/stores/workspace-store"
import { hiddenStreamIds } from "@/lib/streams"
import { buildPageTitle, usePageStreamName } from "@/lib/page-title"

const DARK_FAVICON_SVG = `<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M 50 24 C 64 30, 72 42, 72 50 C 72 58, 64 70, 50 76 C 36 70, 28 58, 28 50 C 28 42, 36 30, 50 24 Z"
        stroke="#C8A055" stroke-width="5" fill="none"/>
  <path d="M 50 14 C 47 26, 46 38, 50 50 C 54 62, 53 74, 50 86"
        stroke="#C8A055" stroke-width="6" stroke-linecap="round" fill="none"/>
</svg>`

const LIGHT_FAVICON_SVG = `<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M 50 24 C 64 30, 72 42, 72 50 C 72 58, 64 70, 50 76 C 36 70, 28 58, 28 50 C 28 42, 36 30, 50 24 Z"
        stroke="#8B7332" stroke-width="5" fill="none"/>
  <path d="M 50 14 C 47 26, 46 38, 50 50 C 54 62, 53 74, 50 86"
        stroke="#8B7332" stroke-width="6" stroke-linecap="round" fill="none"/>
</svg>`

function addNotificationDot(baseSvg: string): string {
  const dot = `<circle cx="78" cy="22" r="14" fill="#EF4444"/>`
  return baseSvg.replace("</svg>", `  ${dot}\n</svg>`)
}

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function isDarkMode(): boolean {
  return document.documentElement.classList.contains("dark")
}

function setFavicon(href: string) {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
  for (const link of links) {
    link.href = href
  }
}

/**
 * Updates the document title and favicon to reflect unread message count.
 * Reads unread counts from IDB via useLiveQuery — reactive and offline-capable.
 */
export function useUnreadTabIndicator(workspaceId: string) {
  const unreadState = useWorkspaceUnreadState(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const streamName = usePageStreamName()

  const unreadCounts = unreadState?.unreadCounts ?? {}
  const mutedStreamIds = unreadState?.mutedStreamIds ?? []

  const muted = new Set(mutedStreamIds)
  // A hidden stream (an aside, or a thread inside one) is a pull surface: its
  // unread never lights the badge — the anchor row's state text is its whole
  // signal.
  const hidden = hiddenStreamIds(streams)
  let totalUnread = 0
  for (const [streamId, count] of Object.entries(unreadCounts)) {
    if (!muted.has(streamId) && !hidden.has(streamId)) totalUnread += count
  }

  useEffect(() => {
    document.title = buildPageTitle(totalUnread, streamName)
  }, [totalUnread, streamName])

  useEffect(() => {
    const dark = isDarkMode()
    const baseSvg = dark ? DARK_FAVICON_SVG : LIGHT_FAVICON_SVG
    const svg = totalUnread > 0 ? addNotificationDot(baseSvg) : baseSvg
    setFavicon(svgToDataUri(svg))
  }, [totalUnread])

  useEffect(() => {
    let lastDark = isDarkMode()
    const themeObserver = new MutationObserver(() => {
      const nowDark = isDarkMode()
      if (nowDark === lastDark) return
      lastDark = nowDark
      const baseSvg = nowDark ? DARK_FAVICON_SVG : LIGHT_FAVICON_SVG
      const svg = totalUnread > 0 ? addNotificationDot(baseSvg) : baseSvg
      setFavicon(svgToDataUri(svg))
    })
    themeObserver.observe(document.documentElement, { attributeFilter: ["class"] })
    return () => {
      themeObserver.disconnect()
      document.title = buildPageTitle(0)
      const dark = isDarkMode()
      setFavicon(svgToDataUri(dark ? DARK_FAVICON_SVG : LIGHT_FAVICON_SVG))
    }
  }, [workspaceId, totalUnread])
}
