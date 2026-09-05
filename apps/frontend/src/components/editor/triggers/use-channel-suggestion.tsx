import { useCallback, useMemo } from "react"
import { useParams } from "react-router-dom"
import { StreamTypes } from "@threa/types"
import type { ChannelItem } from "./types"
import { ChannelList } from "./channel-list"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { rankMatches } from "@/lib/match-score"
import { getStreamName, isLinkableStreamType, isUtilityStream, streamChipSlug, streamLabel } from "@/lib/streams"
import { useSuggestion } from "./use-suggestion"

/** Sort key placing channels ahead of scratchpads. */
function channelsFirst(type: string): number {
  return type === StreamTypes.CHANNEL ? 0 : 1
}

/**
 * Split a `#` query into its scope and search term. A second `#` narrows the
 * list to channels — `##pi` finds `#pizza` while `#pi` also finds the "Pi remote
 * control" scratchpad.
 */
export function parseChannelQuery(query: string): { channelsOnly: boolean; term: string } {
  return query.startsWith("#") ? { channelsOnly: true, term: query.slice(1) } : { channelsOnly: false, term: query }
}

/**
 * Filter and rank streams by query string: exact/prefix matches on slug or
 * name rank above mid-word substring hits.
 */
export function filterChannels(items: ChannelItem[], query: string): ChannelItem[] {
  const { channelsOnly, term } = parseChannelQuery(query)
  // A bare `##` is also a markdown h2 marker. Offering the whole channel list
  // there would let Enter pick one instead of sending, so the narrowed scope
  // stays silent until a term is typed — the bare `#` already opens on channels.
  if (channelsOnly && !term.trim()) return []
  const scope = channelsOnly ? items.filter((item) => item.type === "channel") : items
  return rankMatches(scope, term, (item) => ({ labels: item.name ? [item.slug, item.name] : [item.slug] }))
}

export function useChannelSuggestion() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const streams = useWorkspaceStreams(workspaceId ?? "")

  const channels = useMemo<ChannelItem[]>(() => {
    return (
      streams
        // Archived rows persist in the stream cache (archived-stream index);
        // offering a workspace's whole archival history as #-link targets is
        // noise, so suggest active streams only. Channels lead scratchpads so an
        // unfiltered `#` opens on the shared rooms. A stream with no name yet
        // has nothing to match or label a chip with — every one of them would
        // read "Untitled" and insert the same `#untitled`.
        .filter(
          (stream) =>
            isLinkableStreamType(stream.type) &&
            !stream.archivedAt &&
            !isUtilityStream(stream) &&
            getStreamName(stream) !== null
        )
        .sort((a, b) => channelsFirst(a.type) - channelsFirst(b.type))
        .map((stream) => {
          // The row prints the sigil itself, so carry the bare name — a channel's
          // `streamLabel` is already `#slug` and would double it.
          const label = streamLabel(stream, "generic")
          return {
            id: stream.id,
            slug: streamChipSlug(stream),
            name: label.startsWith("#") ? label.slice(1) : label,
            type: stream.type === StreamTypes.SCRATCHPAD ? ("scratchpad" as const) : ("channel" as const),
          }
        })
    )
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
