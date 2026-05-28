import { forwardRef } from "react"
import type { Placement } from "@floating-ui/react"
import { Hash } from "lucide-react"
import type { Memo } from "@threa/types"
import { getKnowledgeConfig } from "@/lib/memo-display"
import { SuggestionList, type SuggestionListRef } from "./suggestion-list"

export type MemoSuggestionListRef = SuggestionListRef

interface MemoSuggestionListProps {
  items: Memo[]
  clientRect: (() => DOMRect | null) | null
  command: (item: Memo) => void
  placement?: Placement
}

function MemoSuggestionItem({ item }: { item: Memo }) {
  const config = getKnowledgeConfig(item.knowledgeType)
  const Icon = config.icon
  const tags = item.tags.slice(0, 2)

  return (
    <>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col items-start">
        <span className="w-full truncate text-[13px] font-medium leading-snug">{item.title}</span>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium lowercase text-primary/90">{config.label}</span>
          {tags.map((tag) => (
            <span key={tag} className="inline-flex min-w-0 items-center gap-0.5 text-muted-foreground/70">
              <Hash className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate lowercase">{tag}</span>
            </span>
          ))}
        </div>
      </div>
    </>
  )
}

/**
 * Autocomplete list for the inline `/memo` search trigger. Shows matching memos
 * with their knowledge-type icon, title, and tags.
 */
export const MemoSuggestionList = forwardRef<MemoSuggestionListRef, MemoSuggestionListProps>(
  function MemoSuggestionList({ items, clientRect, command, placement }, ref) {
    return (
      <SuggestionList
        ref={ref}
        items={items}
        clientRect={clientRect}
        command={command}
        getKey={(item) => item.id}
        ariaLabel="Memo suggestions"
        renderItem={(item) => <MemoSuggestionItem item={item} />}
        placement={placement}
        width="w-80"
        emptyState="No memos found"
      />
    )
  }
)
