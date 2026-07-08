import { ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"
import { useForwardScroll } from "@/hooks/use-forward-scroll"

interface BoardNewPostsPillProps {
  /** Number of buffered new posts. */
  count: number
  /** Scroll to the top and commit the buffered order. */
  onReveal: () => void
  /**
   * The board's owned scroll viewport. The pill is an overlay SIBLING of the
   * scroller (not a descendant, or it would scroll away), so a wheel/touch landing
   * on its `pointer-events-auto` button would otherwise be trapped and not scroll
   * the feed — `useForwardScroll` forwards it, same as the stream date pill.
   */
  scrollerRef: React.RefObject<HTMLElement | null>
}

/**
 * Floating "N new" pill, templated on the stream date pill (`StreamDateHeader`):
 * a muted rounded chip floating over the TOP of the feed (`absolute`, pointer
 * events only on the control) so buffered new posts never shove the composer/feed
 * down — the old in-flow banner grew the column and nudged everything below it.
 * A touch more prominent than a passive date label (primary accent) since it is
 * an action, not a marker; clicking scrolls to the top and commits the buffered
 * order. Never shifts feed layout (INV-21).
 */
export function BoardNewPostsPill({ count, onReveal, scrollerRef }: BoardNewPostsPillProps) {
  const forwardScroll = useForwardScroll(scrollerRef)
  return (
    <div className="pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2">
      <button
        type="button"
        onClick={onReveal}
        aria-label={`Show ${count} new ${count === 1 ? "post" : "posts"}`}
        {...forwardScroll}
        className={cn(
          "pointer-events-auto inline-flex items-center gap-1 rounded-full border px-3 py-1.5",
          "bg-background/95 text-xs font-medium text-primary shadow-sm backdrop-blur",
          "transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        )}
      >
        <ArrowUp className="-ml-0.5 h-3 w-3" aria-hidden />
        {count} new
      </button>
    </div>
  )
}
