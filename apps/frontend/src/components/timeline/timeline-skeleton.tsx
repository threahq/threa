import { MessageRowSkeleton, type MessageRowSkeletonShape } from "@/components/message/message-row-skeleton"

const ROWS: MessageRowSkeletonShape[] = [
  { continuation: false, width: "w-11/12" },
  { continuation: true, width: "w-2/3" },
  { continuation: false, width: "w-3/4" },
]

/** Placeholder rows in the timeline's reading column, for a box that already reserves the scroller's gutter. */
export function TimelineSkeletonRows() {
  return (
    <div aria-hidden className="mx-auto w-full min-w-0 max-w-[800px] py-3">
      {ROWS.map((row, i) => (
        <MessageRowSkeleton key={i} {...row} className="px-gutter" />
      ))}
    </div>
  )
}

/**
 * The one skeleton a timeline shows before its rows: the active-load branch, the cold-boot fallback and a
 * pane still gliding in share it, so the seam to the first painted rows is invisible. It reserves the
 * scrollbar gutter the timeline scroller does, so its column lands exactly where the rows will.
 */
export function TimelineSkeleton() {
  return (
    <div className="h-full overflow-hidden [scrollbar-gutter:stable]">
      <TimelineSkeletonRows />
    </div>
  )
}
