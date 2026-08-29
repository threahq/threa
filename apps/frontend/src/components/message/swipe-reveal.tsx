import { Quote, MessageSquareDashed } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SwipeArm } from "@/hooks/use-swipe-action"

/**
 * What a swiped row reveals behind itself: the quote glyph, gold once the
 * swipe is locked; the aside glyph, gold, once the L's downward leg arms it.
 * The two glyphs share one slot so the swap never moves the row.
 */
export function SwipeReveal({ locked, arm }: { locked: boolean; arm: SwipeArm }) {
  const down = arm === "down"
  return (
    <div className="absolute inset-y-0 right-0 flex items-center pr-4" data-swipe-arm={arm}>
      {down ? (
        <MessageSquareDashed className="h-5 w-5 text-primary" />
      ) : (
        <Quote className={cn("h-5 w-5 transition-colors", locked ? "text-primary" : "text-muted-foreground")} />
      )}
    </div>
  )
}
