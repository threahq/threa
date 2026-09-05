import { forwardRef } from "react"
import type { Placement } from "@floating-ui/react"
import { SuggestionList, type SuggestionListRef } from "./suggestion-list"
import type { ChannelItem } from "./types"
import { STREAM_ICONS } from "@/lib/streams"

export type ChannelListRef = SuggestionListRef

interface ChannelListProps {
  items: ChannelItem[]
  clientRect: (() => DOMRect | null) | null
  command: (item: ChannelItem) => void
  placement?: Placement
}

function ChannelItemContent({ item }: { item: ChannelItem }) {
  const Icon = STREAM_ICONS[item.type]
  return (
    <>
      <Icon className="h-4 w-4 text-green-600 dark:text-green-400" />
      <div className="flex flex-1 flex-col items-start">
        <span className="font-medium">{item.name ?? item.slug}</span>
        <span className="text-xs text-muted-foreground">
          #{item.slug}
          {item.memberCount !== undefined && ` · ${item.memberCount} members`}
        </span>
      </div>
    </>
  )
}

/**
 * Autocomplete list for #stream links.
 * Shows available channels and scratchpads with keyboard navigation.
 */
export const ChannelList = forwardRef<ChannelListRef, ChannelListProps>(function ChannelList(
  { items, clientRect, command, placement },
  ref
) {
  return (
    <SuggestionList
      ref={ref}
      items={items}
      clientRect={clientRect}
      command={command}
      getKey={(item) => item.id}
      ariaLabel="Stream suggestions"
      renderItem={(item) => <ChannelItemContent item={item} />}
      placement={placement}
    />
  )
})
