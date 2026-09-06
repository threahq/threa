import { forwardRef, useCallback } from "react"
import { Sparkles } from "lucide-react"
import { SuggestionList, type SuggestionListRef, type SuggestionListProps } from "./suggestion-list"
import type { SteerItem } from "./steer-extension"

interface SteerListProps extends Omit<SuggestionListProps<SteerItem>, "getKey" | "ariaLabel" | "renderItem"> {}

export const SteerList = forwardRef<SuggestionListRef, SteerListProps>(function SteerList(
  { items, clientRect, command, placement },
  ref
) {
  const renderItem = useCallback((item: SteerItem) => <SteerItemContent item={item} />, [])

  return (
    <SuggestionList
      ref={ref}
      items={items}
      clientRect={clientRect}
      command={command}
      getKey={(item) => item.id}
      ariaLabel="Search commands"
      width="280px"
      renderItem={renderItem}
      placement={placement}
    />
  )
})

function SteerItemContent({ item }: { item: SteerItem }) {
  return (
    <>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex flex-1 flex-col items-start min-w-0">
        <span className="font-medium">/{item.id}</span>
        <span className="text-xs text-muted-foreground truncate">{item.description}</span>
      </div>
    </>
  )
}
