import { useEffect } from "react"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer"
import { useSidebar } from "@/contexts"
import { cn } from "@/lib/utils"
import { StreamContextPanel } from "./stream-context-panel"

interface StreamContextSurfaceProps {
  workspaceId: string
  streamId: string
  open: boolean
  onClose: () => void
  onJumpToMessage: (messageId: string) => void
  onOpenThread: (threadId: string) => void
  onOpenMemo: (memoId: string) => void
}

/**
 * Hosts the "In this stream" overview: a right-side slide-out on desktop and a
 * bottom drawer on mobile. The same {@link StreamContextPanel} renders inside
 * both. Desktop stays mounted so the slide transition can play on close.
 */
export function StreamContextSurface(props: StreamContextSurfaceProps) {
  const { isMobile } = useSidebar()
  const { open, onClose } = props

  // Escape closes the desktop slide-out (the mobile drawer handles its own).
  useEffect(() => {
    if (isMobile || !open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isMobile, open, onClose])

  const panel = (
    <StreamContextPanel
      workspaceId={props.workspaceId}
      streamId={props.streamId}
      onClose={onClose}
      onJumpToMessage={props.onJumpToMessage}
      onOpenThread={props.onOpenThread}
      onOpenMemo={props.onOpenMemo}
    />
  )

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={(next) => !next && onClose()}>
        <DrawerContent className="h-[88dvh]">
          <DrawerTitle className="sr-only">In this stream</DrawerTitle>
          <DrawerDescription className="sr-only">
            Links, files, images, and captured memories from this conversation.
          </DrawerDescription>
          <div className="flex min-h-0 flex-1 flex-col">{panel}</div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        role="dialog"
        aria-label="In this stream"
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[26rem] max-w-full flex-col border-l bg-background shadow-xl",
          "transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "pointer-events-none translate-x-full"
        )}
      >
        {panel}
      </div>
    </>
  )
}
