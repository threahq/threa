import { createContext, useContext, useMemo, type ReactNode } from "react"
import { type StreamType } from "@threa/types"
import { isLinkableStreamType, streamChipSlug } from "@/lib/streams"

interface ChannelLinkContextValue {
  getChannelUrl: (slug: string) => string | null
  /** Resolve a stream URL from a `stream_` id (the authoritative pointer-link
   *  reference, INV-64). Returns null for anything outside the viewer's cached
   *  linkable streams, so an inaccessible or non-linkable target renders as
   *  plain text, not a dead link. */
  getChannelUrlById: (id: string) => string | null
  /** The target's current chip label, so a renamed channel or scratchpad reads
   *  under its new name instead of the one frozen into the link at authoring
   *  time. Null for uncached ids — the caller then keeps the authored label. */
  getChannelLabelById: (id: string) => string | null
}

const ChannelLinkContext = createContext<ChannelLinkContextValue | null>(null)

interface ChannelLinkProviderProps {
  workspaceId: string
  streams: ReadonlyArray<{ id: string; type: StreamType; slug: string | null; displayName?: string | null }>
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
    const idToLabel = new Map<string, string>()
    for (const stream of streams) {
      if (isLinkableStreamType(stream.type)) {
        const url = `/w/${workspaceId}/s/${stream.id}`
        idToUrl.set(stream.id, url)
        idToLabel.set(stream.id, streamChipSlug(stream))
        if (stream.slug) slugToUrl.set(stream.slug, url)
      }
    }
    return {
      getChannelUrl: (slug: string) => slugToUrl.get(slug) ?? null,
      getChannelUrlById: (id: string) => idToUrl.get(id) ?? null,
      getChannelLabelById: (id: string) => idToLabel.get(id) ?? null,
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

/**
 * Hook to get a channel/scratchpad's current chip label from its `stream_` id.
 * Returns null resolver if not within ChannelLinkProvider.
 */
export function useChannelLabelById(): (id: string) => string | null {
  const context = useContext(ChannelLinkContext)
  if (!context) {
    return () => null
  }
  return context.getChannelLabelById
}
