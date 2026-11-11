import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react"
import { linkFaviconHost, type LinkPreviewSummary } from "@threahq/types"

interface LinkPreviewContextValue {
  hoveredLinkUrl: string | null
  setHoveredLinkUrl: (url: string | null) => void
  faviconHosts: ReadonlySet<string>
}

const LinkPreviewContext = createContext<LinkPreviewContextValue | null>(null)

export function useLinkPreviewContext() {
  return useContext(LinkPreviewContext)
}

export function LinkPreviewProvider({
  previews,
  children,
}: {
  previews?: readonly LinkPreviewSummary[]
  children: ReactNode
}) {
  const [hoveredLinkUrl, setHoveredLinkUrl] = useState<string | null>(null)

  const handleSetHoveredUrl = useCallback((url: string | null) => {
    setHoveredLinkUrl(url)
  }, [])

  const faviconHosts = useMemo(() => {
    const hosts = new Set<string>()
    for (const preview of previews ?? []) {
      if (!preview.faviconUrl) continue
      const host = linkFaviconHost(preview.url)
      if (host) hosts.add(host)
    }
    return hosts
  }, [previews])

  const value = useMemo(
    () => ({ hoveredLinkUrl, setHoveredLinkUrl: handleSetHoveredUrl, faviconHosts }),
    [hoveredLinkUrl, handleSetHoveredUrl, faviconHosts]
  )

  return <LinkPreviewContext.Provider value={value}>{children}</LinkPreviewContext.Provider>
}
