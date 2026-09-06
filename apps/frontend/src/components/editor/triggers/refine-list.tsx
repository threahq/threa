import { forwardRef, useCallback } from "react"
import { Sparkles } from "lucide-react"
import { SuggestionList, type SuggestionListRef, type SuggestionListProps } from "./suggestion-list"
import type { RefineItem } from "./refine-extension"

interface RefineListProps extends Omit<SuggestionListProps<RefineItem>, "getKey" | "ariaLabel" | "renderItem"> {}

export const RefineList = forwardRef<SuggestionListRef, RefineListProps>(function RefineList(
  { items, clientRect, command, placement },
  ref
) {
  const renderItem = useCallback((item: RefineItem) => <RefineItemContent item={item} />, [])

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

function RefineItemContent({ item }: { item: RefineItem }) {
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
