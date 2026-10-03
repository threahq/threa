import { createPortal } from "react-dom"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import { useSidebar } from "@/contexts"
import { useStreamContextDock } from "./stream-context-dock"
import { StreamContextIndexPanel } from "./stream-context-index-panel"

interface StreamContextSurfaceProps {
  workspaceId: string
  streamId: string
  open: boolean
  onClose: () => void
  onJumpToMessage: (messageId: string) => void
  onOpenThread: (threadId: string) => void
  onOpenMemo: (memoId: string) => void
  onOpenGallery: (key: string) => void
}

/**
 * Hosts the "In this stream" overview: the page's docked right-edge column on
 * desktop, beside the stream it lists, and a bottom drawer on mobile. The same
 * {@link StreamContextIndexPanel} renders inside both.
 */
export function StreamContextSurface(props: StreamContextSurfaceProps) {
  const { isMobile } = useSidebar()
  const dock = useStreamContextDock()
  const { open, onClose } = props

  const panel = (
    <StreamContextIndexPanel
      workspaceId={props.workspaceId}
      streamId={props.streamId}
      onClose={onClose}
      onJumpToMessage={props.onJumpToMessage}
      onOpenThread={props.onOpenThread}
      onOpenMemo={props.onOpenMemo}
      onOpenGallery={props.onOpenGallery}
    />
  )

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
        <DrawerContent className="h-[88dvh]">
          <DrawerTitle className="sr-only">In this stream</DrawerTitle>
          <DrawerDescription className="sr-only">
            Links, files, images, captured memories, and delegated tasks from this conversation.
          </DrawerDescription>
          <div className="flex min-h-0 flex-1 flex-col">{panel}</div>
        </DrawerContent>
      </Drawer>
    )
  }

  if (!open || !dock?.target) return null
  return createPortal(
    <aside
      aria-label="In this stream"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) onClose()
      }}
    >
      {panel}
    </aside>,
    dock.target
  )
}
