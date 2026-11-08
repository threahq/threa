import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { MESSAGE_ROW_CONTINUATION_PADDING, MESSAGE_ROW_HEAD_PADDING } from "./message-row-layout"

export interface MessageRowSkeletonShape {
  continuation: boolean
  /** Width class of the body line, so a run reads as grouped messages rather than identical blocks. */
  width: string
}

/**
 * A loading row with a real message row's geometry: the `md` avatar box, `gap-3`, `MESSAGE_ROW_*_PADDING`.
 * It sits on its surface's content edge; pass `px-timeline-gutter` where the column itself has no padding.
 */
export function MessageRowSkeleton({
  continuation,
  width,
  className,
}: MessageRowSkeletonShape & { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-3",
        continuation ? MESSAGE_ROW_CONTINUATION_PADDING : MESSAGE_ROW_HEAD_PADDING,
        className
      )}
    >
      {continuation ? <div className="h-8 w-8 shrink-0" /> : <Skeleton className="h-8 w-8 shrink-0 rounded-[8px]" />}
      <div className="min-w-0 flex-1">
        {!continuation && (
          <div className="mb-0.5 flex items-baseline gap-2">
            <Skeleton className="h-5 w-28" />
          </div>
        )}
        <Skeleton className={cn("h-[22px]", width)} />
      </div>
    </div>
  )
}
