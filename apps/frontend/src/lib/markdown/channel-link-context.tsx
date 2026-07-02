import { createContext, useContext, useMemo, type ReactNode } from "react"
import { StreamTypes, type StreamType } from "@threa/types"

interface ChannelLinkContextValue {
  getChannelUrl: (slug: string) => string | null
  /** Resolve a channel URL from a `stream_` id (the authoritative pointer-link
   *  reference, INV-64). Returns null for ids that aren't a known channel, so an
   *  inaccessible or non-channel stream renders as plain text, not a dead link. */
  getChannelUrlById: (id: string) => string | null
}

const ChannelLinkContext = createContext<ChannelLinkContextValue | null>(null)

interface ChannelLinkProviderProps {
  workspaceId: string
  streams: ReadonlyArray<{ id: string; type: StreamType; slug: string | null }>
  children: ReactNode
}

/**
 * Provider that supplies channel slug → URL lookup for rendered messages.
 * Wraps content to enable clickable #channel mentions.
 */
export function ChannelLinkProvider({ workspaceId, streams, children }: ChannelLinkProviderProps) {
  const value = useMemo<ChannelLinkContextValue>(() => {
    const slugToUrl = new Map<string, string>()
    const idToUrl = new Map<string, string>()
    for (const stream of streams) {
      if (stream.type === StreamTypes.CHANNEL) {
        const url = `/w/${workspaceId}/s/${stream.id}`
        idToUrl.set(stream.id, url)
        if (stream.slug) slugToUrl.set(stream.slug, url)
      }
    }
    return {
      getChannelUrl: (slug: string) => slugToUrl.get(slug) ?? null,
      getChannelUrlById: (id: string) => idToUrl.get(id) ?? null,
    }
  }, [workspaceId, streams])

  return <ChannelLinkContext.Provider value={value}>{children}</ChannelLinkContext.Provider>
}

/**
 * Hook to get channel URL from slug.
 * Returns null resolver if not within ChannelLinkProvider.
 */
export function useChannelUrl(): (slug: string) => string | null {
  const context = useContext(ChannelLinkContext)
  if (!context) {
    return () => null
  }
  return context.getChannelUrl
}

/**
 * Hook to get channel URL from a `stream_` id (pointer-link mentions).
 * Returns null resolver if not within ChannelLinkProvider.
 */
export function useChannelUrlById(): (id: string) => string | null {
  const context = useContext(ChannelLinkContext)
  if (!context) {
    return () => null
  }
  return context.getChannelUrlById
}
