import { forwardRef } from "react"
import type { Placement } from "@floating-ui/react"
import { SlidersHorizontal } from "lucide-react"
import type { CommandArgumentSuggestion } from "@threa/types"
import { SuggestionList, type SuggestionListRef } from "./suggestion-list"

export type CommandArgPickerRef = SuggestionListRef

interface CommandArgPickerProps {
  items: CommandArgumentSuggestion[]
  clientRect: (() => DOMRect | null) | null
  command: (item: CommandArgumentSuggestion) => void
  placement?: Placement
}

function CommandArgContent({ item }: { item: CommandArgumentSuggestion }) {
  // Prefer the human label as the primary line; fall back to the raw value the
  // backend resolves on (e.g. `provider/model-id`). Show the value/description
  // underneath only when it differs from what's already on the primary line.
  const primary = item.label ?? item.value
  const secondary = item.label ? item.value : item.description
  return (
    <>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
        <SlidersHorizontal className="h-4 w-4" />
      </div>
      <div className="flex flex-1 flex-col items-start min-w-0 overflow-hidden">
        <span className="text-[13px] font-medium truncate w-full">{primary}</span>
        {secondary ? <span className="text-xs text-muted-foreground truncate w-full">{secondary}</span> : null}
      </div>
    </>
  )
}

/**
 * Option picker for a slash command's argument. Opens right after a command
 * with advertised `args[].suggestions` is selected (e.g. `/model`), so the user
 * picks a value from the list instead of typing it. Built on the same
 * `SuggestionList` as the @mention / #channel / /command popovers.
 */
export const CommandArgPicker = forwardRef<CommandArgPickerRef, CommandArgPickerProps>(function CommandArgPicker(
  { items, clientRect, command, placement },
  ref
) {
  return (
    <SuggestionList
      ref={ref}
      items={items}
      clientRect={clientRect}
      command={command}
      getKey={(item) => item.value}
      ariaLabel="Command option suggestions"
      width="w-[300px]"
      renderItem={(item) => <CommandArgContent item={item} />}
      placement={placement}
    />
  )
})
