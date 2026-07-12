import { type ReactNode } from "react"
import { X } from "lucide-react"
import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogTitle } from "@/components/ui/responsive-dialog"
import { Button } from "@/components/ui/button"

export interface OverlayComposerShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accessible title for the dialog (also used by screen readers). */
  title: string
  /** Header content — the target picker chip or the stream label. Sits left of the close. */
  header: ReactNode
  children: ReactNode
}

/**
 * The overlay composer's chrome: a centered Linear-style modal on desktop, a
 * ~fullscreen bottom drawer on mobile — the single surface the board and (step
 * 4) the timeline fullscreen editor both host `<MessageComposer expanded>` in.
 *
 * `disableSnapPoints` is mandatory here: the composer holds a text input, and the
 * snap-point drawer is forced to `h-[100dvh]` — when the keyboard opens it slides
 * the header off under the status bar. A content-height drawer (fixed `h-[92dvh]`)
 * rides above the keyboard instead, the same choreography the persona test-chat
 * drawer uses. The app `Drawer` already runs `repositionInputs={false}` so dvh is
 * the single source of truth.
 */
export function OverlayComposerShell({ open, onOpenChange, title, header, children }: OverlayComposerShellProps) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} disableSnapPoints>
      <ResponsiveDialogContent
        hideCloseButton
        desktopClassName="flex h-[85vh] max-h-[760px] w-[92vw] max-w-[820px] flex-col gap-0 overflow-hidden p-0"
        drawerClassName="mt-0 flex h-[92dvh] flex-col gap-0 p-0"
        onPointerDownOutside={(e) => {
          // Don't close when a click lands on an editor suggestion popover
          // (@mention / emoji / slash) that portals outside the dialog.
          if ((e.target as HTMLElement).closest('[role="listbox"]')) e.preventDefault()
        }}
      >
        <ResponsiveDialogTitle className="sr-only">{title}</ResponsiveDialogTitle>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
          <div className="min-w-0 flex-1">{header}</div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close editor"
            className="h-8 w-8 shrink-0"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
