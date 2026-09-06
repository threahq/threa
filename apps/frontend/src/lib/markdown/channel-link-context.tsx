import { createContext, useContext, useMemo, type ReactNode } from "react"
import { type StreamType } from "@threahq/types"
import { isLinkableStreamType, streamLabel } from "@/lib/streams"

interface ChannelLinkContextValue {
  getChannelUrl: (slug: string) => string | null
  /** Resolve a stream URL from a `stream_` id (the authoritative pointer-link
   *  reference, INV-64). Returns null for anything outside the viewer's cached
   *  linkable streams, so an inaccessible or non-linkable target renders as
   *  plain text, not a dead link. */
  getChannelUrlById: (id: string) => string | null
  /** The target's current chip identity — live name plus stream type, so a
   *  renamed channel or scratchpad reads under its new name (and its own glyph)
   *  instead of the slug frozen into the link at authoring time. Null for
   *  uncached ids — the caller then keeps the authored label. */
  getChannelChipById: (id: string) => { type: StreamType; label: string } | null
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
    const idToChip = new Map<string, { type: StreamType; label: string }>()
    for (const stream of streams) {
      if (isLinkableStreamType(stream.type)) {
        const url = `/w/${workspaceId}/s/${stream.id}`
        idToUrl.set(stream.id, url)
        idToChip.set(stream.id, { type: stream.type, label: streamLabel(stream) })
        if (stream.slug) slugToUrl.set(stream.slug, url)
      }
    }
    return {
      getChannelUrl: (slug: string) => slugToUrl.get(slug) ?? null,
      getChannelUrlById: (id: string) => idToUrl.get(id) ?? null,
      getChannelChipById: (id: string) => idToChip.get(id) ?? null,
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
 * Hook to get a channel/scratchpad's current chip identity from its `stream_` id.
 * Returns null resolver if not within ChannelLinkProvider.
 */
export function useChannelChipById(): (id: string) => { type: StreamType; label: string } | null {
  const context = useContext(ChannelLinkContext)
  if (!context) {
    return () => null
  }
  return context.getChannelChipById
}
