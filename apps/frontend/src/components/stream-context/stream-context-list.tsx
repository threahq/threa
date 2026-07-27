import { Virtualizer, type VirtualizerHandle } from "virtua"
import type { ReactNode, RefObject } from "react"

/**
 * The "In this stream" timeline's virtualization boundary, mirroring
 * `BoardFeedList`. Wraps `virtua`'s `Virtualizer` over the scroller the panel
 * owns so only on-screen rows mount — a busy stream indexes hundreds of
 * artifacts and the panel pages further on scroll, so the row count grows
 * without bound.
 *
 * A plain function component on purpose: it is the single seam tests replace
 * with a passthrough via namespace `spyOn` (INV-48), since `virtua` renders
 * nothing under jsdom's zero-height, no-op-ResizeObserver layout. Keep this
 * module free of panel logic so that swap stays a pure render passthrough.
 */
export interface StreamContextListProps {
  /** The scroller the panel owns; virtua reads native scroll metrics off it. */
  scrollRef: RefObject<HTMLDivElement | null>
  /** virtua's imperative handle, so a date jump can `scrollToIndex` a row that
   *  is not mounted — the whole point of windowing is that it usually isn't. */
  listRef?: RefObject<VirtualizerHandle | null>
  children: ReactNode
}

// Off-screen px kept mounted so a fling doesn't outrun mount+measure and flash
// blank rows. Context rows are short and cheap next to board cards, so this can
// be generous.
const BUFFER_SIZE_PX = 600

export function StreamContextList({ scrollRef, listRef, children }: StreamContextListProps) {
  return (
    <Virtualizer ref={listRef} scrollRef={scrollRef} bufferSize={BUFFER_SIZE_PX}>
      {children}
    </Virtualizer>
  )
}
