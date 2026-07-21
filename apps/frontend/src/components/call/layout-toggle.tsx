import { LayoutGrid, Users } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { useCallPrefs, setCallLayout } from "@/stores/call-prefs-store"

const ITEM_CLASS =
  "min-w-0 gap-1.5 rounded-[0.3125rem] px-2.5 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm [&_svg]:size-3.5"

interface LayoutToggleProps {
  /** Restyle for a dark call-stage header (ch5); merged over the default chrome styling. */
  className?: string
}

export function LayoutToggle({ className }: LayoutToggleProps) {
  const { layout } = useCallPrefs()
  return (
    <ToggleGroup
      type="single"
      size="sm"
      role="radiogroup"
      value={layout}
      onValueChange={(next) => {
        if (next === "speaker" || next === "grid") setCallLayout(next)
      }}
      aria-label="Call layout"
      className={cn("shrink-0 gap-0.5 rounded-md bg-muted p-0.5", className)}
    >
      <ToggleGroupItem value="speaker" aria-label="Speaker" title="Speaker layout" className={cn(ITEM_CLASS, "h-7")}>
        <Users aria-hidden="true" />
        <span>Speaker</span>
      </ToggleGroupItem>
      <ToggleGroupItem value="grid" aria-label="Grid" title="Grid layout" className={cn(ITEM_CLASS, "h-7")}>
        <LayoutGrid aria-hidden="true" />
        <span>Grid</span>
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
