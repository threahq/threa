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

/** Hook for `in:#` filter suggestions (channels) in search context. */
export function useInChannelFilterSuggestion() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const streams = useWorkspaceStreams(workspaceId ?? "")

  const channels = useMemo<ChannelItem[]>(() => {
    return streams
      // Slugged streams only (channels/scratchpads). Archived ones are kept on
      // purpose: search is the one surface where scoping INTO archived content
      // is legitimate, and their rows persist in the cache (archived-stream
      // index) precisely so references like this stay resolvable.
      .filter((stream) => stream.slug)
      .map((stream) => ({
        id: stream.id,
        slug: stream.slug!,
        name: stream.displayName ?? stream.slug!,
        type: (stream.type === "scratchpad" ? "scratchpad" : "channel") as "channel" | "scratchpad",
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
    extensionName: "inChannelFilter",
    getItems: () => channels,
    filterItems: filterChannels,
    renderList,
  })

  return {
    suggestionConfig,
    renderInChannelFilterList: renderSuggestionList,
    isActive,
    close,
  }
}
