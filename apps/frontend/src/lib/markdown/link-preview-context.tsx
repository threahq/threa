import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react"

interface LinkPreviewContextValue {
  hoveredLinkUrl: string | null
  setHoveredLinkUrl: (url: string | null) => void
}

const LinkPreviewContext = createContext<LinkPreviewContextValue | null>(null)

export function useLinkPreviewContext() {
  return useContext(LinkPreviewContext)
}

export function LinkPreviewProvider({ children }: { children: ReactNode }) {
  const [hoveredLinkUrl, setHoveredLinkUrl] = useState<string | null>(null)

  const handleSetHoveredUrl = useCallback((url: string | null) => {
    setHoveredLinkUrl(url)
  }, [])

  const value = useMemo(
    () => ({ hoveredLinkUrl, setHoveredLinkUrl: handleSetHoveredUrl }),
    [hoveredLinkUrl, handleSetHoveredUrl]
  )

  return <LinkPreviewContext.Provider value={value}>{children}</LinkPreviewContext.Provider>
}
