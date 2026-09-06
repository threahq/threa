import { useState } from "react"
import { Sparkles } from "lucide-react"
import type { MemosCapturedEventPayload, StreamEvent } from "@threahq/types"
import { cn } from "@/lib/utils"
import { MemoPreviewDialog } from "@/components/memo/memo-preview-dialog"

interface MemoCapturedEventProps {
  event: StreamEvent
  workspaceId: string
}

/**
 * Timeline row for `memos:captured` — the visible trace of GAM extracting
 * knowledge from this stream (INV-69). The event is appended when the memo
 * batch commits, which per-stream debouncing places just after the source
 * conversation, so the row reads as a small "Threa kept this" gift moment
 * rather than an out-of-place system log line. Each title opens the memo in an
 * in-place preview (`MemoPreviewDialog`) — a modal on desktop, a drawer on
 * mobile — rather than navigating away to the memory explorer, which was
 * disruptive mid-conversation. The dialog footer still links through to the
 * full explorer for anyone who wants it.
 */
export function MemoCapturedEvent({ event, workspaceId }: MemoCapturedEventProps) {
  const payload = event.payload as MemosCapturedEventPayload | undefined
  const [openMemo, setOpenMemo] = useState<{ memoId: string; title: string } | null>(null)
  if (!payload?.memos?.length) return null

  return (
    <div className="py-2 px-3 sm:px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <Sparkles className="inline-block h-3.5 w-3.5 mr-1.5 -mt-0.5 text-amber-500" aria-hidden="true" />
        Saved to memory:{" "}
        {payload.memos.map((memo, index) => (
          <span key={memo.memoId}>
            {index > 0 && ", "}
            <button
              type="button"
              onClick={() => setOpenMemo({ memoId: memo.memoId, title: memo.title })}
              aria-haspopup="dialog"
              className={cn(
                "font-medium text-foreground/80 underline-offset-2 hover:underline",
                "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              )}
            >
              {memo.title}
            </button>
          </span>
        ))}
      </p>
      <MemoPreviewDialog
        open={openMemo !== null}
        onOpenChange={(open) => {
          if (!open) setOpenMemo(null)
        }}
        workspaceId={workspaceId}
        memoId={openMemo?.memoId ?? ""}
        fallbackTitle={openMemo?.title ?? ""}
      />
    </div>
  )
}
