import { Link } from "react-router-dom"
import { Sparkles } from "lucide-react"
import type { MemosCapturedEventPayload, StreamEvent } from "@threa/types"
import { memoDeepLink } from "@/lib/memo-url"

interface MemoCapturedEventProps {
  event: StreamEvent
  workspaceId: string
}

/**
 * Timeline row for `memos:captured` — the visible trace of GAM extracting
 * knowledge from this stream (INV-62). The event is appended when the memo
 * batch commits, which per-stream debouncing places just after the source
 * conversation, so the row reads as a small "Threa kept this" gift moment
 * rather than an out-of-place system log line. Each title deep-links to the
 * memory explorer (`?memo=` is the canonical memo deep-link, see memo-url.ts).
 */
export function MemoCapturedEvent({ event, workspaceId }: MemoCapturedEventProps) {
  const payload = event.payload as MemosCapturedEventPayload | undefined
  if (!payload?.memos?.length) return null

  return (
    <div className="py-2 px-3 sm:px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <Sparkles className="inline-block h-3.5 w-3.5 mr-1.5 -mt-0.5 text-amber-500" aria-hidden="true" />
        Saved to memory:{" "}
        {payload.memos.map((memo, index) => (
          <span key={memo.memoId}>
            {index > 0 && ", "}
            <Link
              to={memoDeepLink(workspaceId, memo.memoId)}
              className="font-medium text-foreground/80 underline-offset-2 hover:underline"
            >
              {memo.title}
            </Link>
          </span>
        ))}
      </p>
    </div>
  )
}
