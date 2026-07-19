import { useCallback, useMemo } from "react"
import { useParams } from "react-router-dom"
import type { ChannelItem } from "./types"
import { ChannelList } from "./channel-list"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { rankMatches } from "@/lib/match-score"
import { useSuggestion } from "./use-suggestion"

/**
 * Filter and rank channels by query string: exact/prefix matches on slug or
 * name rank above mid-word substring hits.
 */
function filterChannels(items: ChannelItem[], query: string): ChannelItem[] {
  return rankMatches(items, query, (item) => ({ labels: item.name ? [item.slug, item.name] : [item.slug] }))
}

export function useChannelSuggestion() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const streams = useWorkspaceStreams(workspaceId ?? "")

  const channels = useMemo<ChannelItem[]>(() => {
    return streams
      // Archived rows persist in the stream cache (archived-stream index);
      // offering a workspace's whole archival history as #-link targets is
      // noise, so suggest active channels only.
      .filter((stream) => stream.type === "channel" && stream.slug && !stream.archivedAt)
      .map((stream) => ({
        id: stream.id,
        slug: stream.slug!,
        name: stream.displayName ?? stream.slug!,
        type: "channel" as const,
      }))
  }, [streams])

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: ChannelItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: ChannelItem) => void
    }) => <ChannelList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />,
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive, close } = useSuggestion<ChannelItem>({
    extensionName: "channelLink",
    getItems: () => channels,
    filterItems: filterChannels,
    renderList,
  })

  return {
    suggestionConfig,
    renderChannelList: renderSuggestionList,
    isActive,
    close,
  }
}
