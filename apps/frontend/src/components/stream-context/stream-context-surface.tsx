import * as DialogPrimitive from "@radix-ui/react-dialog"
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
 * both. Desktop uses the Radix Dialog primitive (not a hand-rolled overlay) so
 * focus is trapped while open, returned to the trigger on close, and the closed
 * panel leaves the tab order entirely instead of lingering off-screen.
 */
export function StreamContextSurface(props: StreamContextSurfaceProps) {
  const { isMobile } = useSidebar()
  const { open, onClose } = props

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
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-40 bg-black/40",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-[26rem] max-w-full flex-col border-l bg-background shadow-xl outline-none",
            "transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right data-[state=closed]:duration-200 data-[state=open]:duration-300"
          )}
        >
          <DialogPrimitive.Title className="sr-only">In this stream</DialogPrimitive.Title>
          {panel}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
