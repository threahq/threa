import { Pencil } from "lucide-react"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface DraftIndicatorProps {
  className?: string
}

/**
 * Sidebar hint that a stream has an unsent draft loaded into its composer — the
 * user navigated away without sending or stashing it. The caller decides when to
 * render it; a stashed draft holds no composer pointer for its scope, so it never
 * qualifies (that's the loaded-vs-stashed distinction this hint draws).
 */
export function DraftIndicator({ className }: DraftIndicatorProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label="Unsent draft"
          className={cn("flex-shrink-0 text-muted-foreground cursor-default", className)}
        >
          <Pencil className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        Unsent draft
      </TooltipContent>
    </Tooltip>
  )
}
