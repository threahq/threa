import { useNavigate, useSearchParams } from "react-router-dom"
import { usePanel } from "@/contexts"
import { memoDeepLink } from "@/lib/memo-url"
import { StreamContextGallery } from "./stream-context-gallery"
import { StreamContextSurface } from "./stream-context-surface"
import { useStreamContextOpen } from "./use-stream-context-open"
import { useStreamGallery } from "./use-stream-gallery"

/**
 * One stream's "In this stream" overview with its media gallery, mounted by the
 * view that shows the stream: the page, or the panel while one is open. Mount
 * exactly one at a time — both read the same `?context` and `?smedia=` params.
 */
export function StreamContextOverlay({ workspaceId, streamId }: { workspaceId: string; streamId: string }) {
  const [isOpen, setOpen] = useStreamContextOpen()
  const [, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { openPanel } = usePanel()
  const gallery = useStreamGallery()

  // Dismiss the overlay so the message is visible underneath. A fresh push
  // gives StreamContent's `?m=` effect a new location key to act on.
  const jumpToMessage = (messageId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("m", messageId)
      next.delete("context")
      return next
    })
  }

  return (
    <>
      <StreamContextSurface
        workspaceId={workspaceId}
        streamId={streamId}
        open={isOpen}
        onClose={() => setOpen(false)}
        onJumpToMessage={jumpToMessage}
        onOpenThread={(threadId) => openPanel(threadId)}
        onOpenMemo={(memoId) => navigate(memoDeepLink(workspaceId, memoId))}
        onOpenGallery={gallery.openGallery}
      />
      <StreamContextGallery
        workspaceId={workspaceId}
        streamId={streamId}
        selectedKey={gallery.selectedKey}
        onSelect={gallery.openGallery}
        onClose={gallery.closeGallery}
      />
    </>
  )
}
