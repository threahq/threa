import { forwardRef } from "react"
import { Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useCoarsePointer } from "@/hooks"
import { cn } from "@/lib/utils"

interface SearchRefineTriggerProps {
  open: boolean
  onToggle: () => void
  className?: string
}

const TOOLTIP =
  "Refine these results in plain words. Keep some, drop some, or say what should come first. Runs a model over the list, a few seconds."

/** Opens the refine row, beside the "Add filter" trigger and sized to match it. */
export const SearchRefineTrigger = forwardRef<HTMLButtonElement, SearchRefineTriggerProps>(function SearchRefineTrigger(
  { open, onToggle, className },
  ref
) {
  const isCoarsePointer = useCoarsePointer()

  const trigger = (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      aria-expanded={open}
      onClick={onToggle}
      // The tooltip is for the pointer. Closing the row hands focus back here,
      // and a focus-opened tooltip would sit over the results it explains.
      onFocus={(event) => event.preventDefault()}
      className={cn("h-6 gap-1 rounded-full px-2 text-[11px] font-normal text-muted-foreground", className)}
    >
      <Sparkles className="h-3 w-3" aria-hidden="true" />
      Refine
    </Button>
  )

  if (isCoarsePointer) return trigger

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs">
        {TOOLTIP}
      </TooltipContent>
    </Tooltip>
  )
})
