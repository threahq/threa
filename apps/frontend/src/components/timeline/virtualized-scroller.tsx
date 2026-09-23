import { type CSSProperties, type ReactNode, useRef } from "react"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { cn } from "@/lib/utils"
import { PopIn, useArrivals } from "./pop-in"

interface VirtualizedScrollerItem {
  /** Stable across renders — this is the virtualizer's identity for the row. */
  key: string
  /** Identity for arrival animation when it outlives `key` — an optimistic
   *  row's client id, which its server row keeps. Defaults to `key`. */
  arrivalKey?: string
  /** An unsent own row; see `useArrivals`. */
  inFlight?: boolean
  node: ReactNode
}

interface VirtualizedScrollerProps {
  /**
   * Remount key. Every piece of scroll state — the owned scroller element, the
   * `useTimelineScroll` ResizeObserver, virtua's measurement cache — is keyed on
   * it, so switching subject resets cleanly and the next subject mounts
   * already-populated at its landing.
   */
  scrollKey: string
  items: readonly VirtualizedScrollerItem[]
  registerScroller: (node: HTMLDivElement | null) => void
  scrollerRef: React.RefObject<HTMLDivElement | null>
  listRef: React.RefObject<VirtualizerHandle | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  shift: boolean
  isInitialSettling: boolean
  onScroll: () => void
  /**
   * Everything above the virtualized window inside the scroll container. Virtua
   * resolves an index to an offset by adding `heightPx`, so `content` renders
   * inside a box of exactly that height — chrome rendered outside the box puts
   * every offset query its height out, which is why the two travel as one prop.
   *
   * `heightPx` must be a number the caller knows on its FIRST render rather than
   * a measurement: virtua records a later startMargin without re-deriving the
   * offsets it already computed from the old one, and an anchor restore loses
   * its target row that way.
   */
  startMargin?: { heightPx: number; content?: ReactNode }
  className?: string
  style?: CSSProperties
  scrollerProps?: React.HTMLAttributes<HTMLElement>
  "data-stream-scroller"?: string
  itemClassName?: string
  /**
   * From `useRenderedContentLatch`, called ABOVE the caller's loading
   * early-returns — see the hook.
   */
  hasRenderedContent: boolean
  /** In flow below the virtualized window, inside the scrolled content. */
  footer?: ReactNode
  /** Floating chrome: outside the scroller, under the settle mask. */
  overlay?: ReactNode
  /**
   * Covers the list while `isInitialSettling`; falls back to `skeleton`. It is
   * absolutely positioned against the caller's nearest positioned ancestor, so
   * the surface mounting this component owns a `relative`/`absolute` box around
   * it — under a static parent the mask covers the whole app instead.
   */
  mask?: ReactNode
  skeleton?: ReactNode
  /**
   * Rows appended at the tail after the landing grow in (`PopIn`). Off while the
   * window isn't the live tail (jump mode), where appends are newer pages.
   */
  animateArrivals?: boolean
}

/**
 * Latches true the first time the window has rows. Call it ABOVE the caller's
 * loading early-returns: it picks skeleton vs. blank for the mid-switch gap
 * where the window is briefly empty, and a latch that unmounts with the
 * scroller answers "skeleton" there and flashes one over chrome the reader is
 * already looking at.
 */
export function useRenderedContentLatch(itemCount: number): boolean {
  const latched = useRef(false)
  if (itemCount > 0) latched.current = true
  return latched.current
}

/**
 * The virtualized timeline scroller: one scroll container, one virtua window,
 * one cold-load settle mask. Shared by every conversation surface so they land
 * and scroll identically — a second copy is how the board conversation panel
 * ended up rendering every row into a plain `overflow-y-auto` div.
 *
 * During the cold-load settle the scroller is mounted (so virtua can measure
 * item heights) but covered by the mask, so the measurement bounce happens
 * off-screen; `useTimelineScroll` flips `isInitialSettling` false once the
 * height stabilises. The mask is pointer-events-none, so an eager scroll still
 * reaches the scroller (which aborts the settle and reveals at once).
 */
export function VirtualizedScroller({
  scrollKey,
  items,
  registerScroller,
  scrollerRef,
  listRef,
  contentRef,
  shift,
  isInitialSettling,
  onScroll,
  startMargin,
  className,
  style,
  scrollerProps,
  itemClassName,
  hasRenderedContent,
  footer,
  overlay,
  mask,
  skeleton,
  animateArrivals = true,
  ...dataAttributes
}: VirtualizedScrollerProps) {
  const arrivals = useArrivals(
    items.map((item) => item.arrivalKey ?? item.key),
    scrollKey,
    animateArrivals && !isInitialSettling,
    new Set(items.filter((item) => item.inFlight).map((item) => item.arrivalKey ?? item.key))
  )

  // Never mount the list empty: the initial landing and the settle mask in
  // useTimelineScroll both arm when items first exist, so a list mounted with
  // zero items paints an empty top-anchored frame and the populate + pin a
  // frame later is visible (the "loads in too low then jumps" report).
  // Deferring the mount until data exists makes the keyed instance mount
  // already-populated, so the mask covers the measurement bounce.
  //
  // Before anything has ever rendered (cold boot) that means holding the
  // skeleton, so the skeleton→content handoff has no blank frame in it. After
  // content has rendered once (a subject switch) a brief blank beats a skeleton
  // flash on top of chrome the reader is already looking at.
  if (items.length === 0) {
    return hasRenderedContent ? <div className="h-full" aria-hidden /> : <>{skeleton}</>
  }

  return (
    <>
      <div
        {...scrollerProps}
        key={scrollKey}
        ref={registerScroller}
        className={cn("h-full overflow-y-auto overflow-x-hidden overscroll-y-contain", className)}
        style={{ overflowAnchor: "none", ...style }}
        onScroll={onScroll}
        // The app shell owns pull-to-refresh globally; without this a touch drag
        // inside a timeline pulls the page instead of scrolling the list.
        data-suppress-pull-refresh="true"
        {...dataAttributes}
      >
        <div ref={contentRef}>
          {startMargin != null && (
            <div
              aria-hidden={startMargin.content == null}
              className="flex flex-col justify-end overflow-hidden"
              style={{ height: startMargin.heightPx }}
            >
              {startMargin.content}
            </div>
          )}
          {/* useTimelineScroll finds virtua's rows through this marker. */}
          <div data-timeline-rows>
            <Virtualizer
              ref={listRef}
              scrollRef={scrollerRef}
              startMargin={startMargin?.heightPx}
              // Maintain scroll from the end when an older page is prepended so the
              // viewport doesn't move — the core reverse-infinite-scroll fix.
              shift={shift}
              // Off-screen px kept mounted so fast scrolling doesn't outrun
              // mount+measure and flash blank rows. Was 1000 when every data tick
              // re-rendered the whole window; with memoized rows the steady-state
              // cost of extra mounted rows is near zero, so a larger buffer buys
              // fling headroom. Mount cost still bounds it — don't raise further
              // without profiling on a low-end device.
              bufferSize={2000}
            >
              {items.map((item) => (
                <PopIn key={item.key} className={itemClassName} arrivedAt={arrivals.get(item.arrivalKey ?? item.key)}>
                  {item.node}
                </PopIn>
              ))}
            </Virtualizer>
          </div>
          {footer}
        </div>
      </div>
      {overlay}
      {isInitialSettling && (
        <div
          aria-hidden
          data-testid="settle-mask"
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden bg-background"
        >
          {mask ?? skeleton}
        </div>
      )}
    </>
  )
}
