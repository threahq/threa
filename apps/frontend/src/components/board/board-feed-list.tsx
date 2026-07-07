import { Virtualizer } from "virtua"
import type { ReactNode, RefObject } from "react"

/**
 * The board feed's virtualization boundary. Wraps `virtua`'s `Virtualizer` over
 * the scroller the board owns, so only the on-screen cards mount — ~430 active
 * cards each mount several ref-counted liveQueries + observers, so windowing is
 * the perf floor.
 *
 * A plain function component (React 19 needs no `forwardRef`) on purpose: it is
 * the single seam tests replace with a passthrough via namespace `spyOn`
 * (INV-48), since `virtua` renders nothing under jsdom's zero-height, no-op-
 * ResizeObserver layout. Keep this module free of board logic so that swap stays
 * a pure render passthrough.
 */
export interface BoardFeedListProps {
  /** The scroller the board owns; virtua reads native scroll metrics off it. */
  scrollRef: RefObject<HTMLDivElement | null>
  /** Height (px) of the composer sitting above the rows in the same scroller, so
   *  virtua's item offsets stay aligned. */
  startMargin: number
  children: ReactNode
}

// Off-screen px kept mounted so a fling doesn't outrun mount+measure and flash
// blank rows. Cards are tall and their mount cost is real (liveQueries), so this
// stays modest — raise only after profiling on a low-end device.
const BUFFER_SIZE_PX = 800

export function BoardFeedList({ scrollRef, startMargin, children }: BoardFeedListProps) {
  return (
    <Virtualizer scrollRef={scrollRef} startMargin={startMargin} bufferSize={BUFFER_SIZE_PX}>
      {children}
    </Virtualizer>
  )
}
