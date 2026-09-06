import { List, MessagesSquare } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { SearchResultDisplayMode } from "@/lib/search-result-display-mode"

interface SearchResultDisplayToggleProps {
  value: SearchResultDisplayMode
  onChange: (mode: SearchResultDisplayMode) => void
  size?: "sm" | "touch"
  className?: string
}

const ITEM_CLASS =
  "min-w-0 gap-1 rounded-[0.3125rem] px-2 text-[11px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm [&_svg]:size-3.5"

const ITEM_SIZE: Record<NonNullable<SearchResultDisplayToggleProps["size"]>, string> = {
  sm: "h-6",
  touch: "h-9",
}

export function SearchResultDisplayToggle({ value, onChange, size = "sm", className }: SearchResultDisplayToggleProps) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next === "clusters" || next === "ranked") onChange(next)
      }}
      aria-label="Search result display"
      className={cn("shrink-0 gap-0.5 rounded-md bg-muted p-0.5", className)}
    >
      <ToggleGroupItem
        value="clusters"
        aria-label="Conversation results"
        title="Conversation results"
        className={cn(ITEM_CLASS, ITEM_SIZE[size])}
      >
        <MessagesSquare aria-hidden="true" />
        <span>Conversations</span>
      </ToggleGroupItem>
      <ToggleGroupItem
        value="ranked"
        aria-label="Ranked results"
        title="Ranked results"
        className={cn(ITEM_CLASS, ITEM_SIZE[size])}
      >
        <List aria-hidden="true" />
        <span>Ranked</span>
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
