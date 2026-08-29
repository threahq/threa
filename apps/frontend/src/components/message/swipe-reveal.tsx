import { Quote, MessageSquareDashed, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SwipeArm } from "@/hooks/use-swipe-action"

interface SwipeRevealProps {
  locked: boolean
  arm: SwipeArm
  /** Whether the L is wired on this row (the hint only shows where it can pay off). */
  canPullDown: boolean
}

/**
 * What a swiped row reveals behind itself: the quote glyph, gold once the
 * swipe is locked, and under it the aside glyph with a down-arrow — the hint
 * that the finger can keep going. Once the L's leg arms it, the aside glyph
 * is the gold one. Both glyphs sit in one slot so the swap never moves the row.
 */
export function SwipeReveal({ locked, arm, canPullDown }: SwipeRevealProps) {
  const down = arm === "down"
  return (
    <div className="absolute inset-y-0 right-0 flex flex-col items-center justify-center pr-4" data-swipe-arm={arm}>
      <Quote className={cn("h-5 w-5 transition-colors", locked && !down ? "text-primary" : "text-muted-foreground")} />
      {canPullDown && (
        <span
          className={cn(
            "mt-0.5 flex items-center gap-0.5 transition-opacity",
            down ? "text-primary" : "text-muted-foreground",
            locked ? "opacity-100" : "opacity-40"
          )}
        >
          <ChevronDown className="h-3 w-3" />
          <MessageSquareDashed className="h-4 w-4" />
        </span>
      )}
    </div>
  )
}
