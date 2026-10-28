import { StreamTargetList } from "@/components/composer"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import {
  ResponsiveAlertDialog,
  ResponsiveAlertDialogAction,
  ResponsiveAlertDialogCancel,
  ResponsiveAlertDialogContent,
  ResponsiveAlertDialogDescription,
  ResponsiveAlertDialogFooter,
  ResponsiveAlertDialogHeader,
  ResponsiveAlertDialogTitle,
} from "@/components/ui/responsive-alert-dialog"
import { cn } from "@/lib/utils"
import { describeAccessChange, type DocMove } from "./use-move-doc"

interface DocMoveDialogProps {
  workspaceId: string
  docTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  docMove: DocMove
}

/** Pick the doc's new host; a move that changes who can read the doc asks first. */
export function DocMoveDialog({ workspaceId, docTitle, open, onOpenChange, docMove }: DocMoveDialogProps) {
  const { isTarget, pick, pending, confirm, cancel, reset, busy } = docMove

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const handleSelect = async (toStreamId: string) => {
    if (busy) return
    if (await pick(toStreamId)) handleOpenChange(false)
  }

  const handleConfirm = async () => {
    if (await confirm()) handleOpenChange(false)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent
        className="overflow-hidden p-0"
        desktopClassName="sm:max-w-lg"
        drawerClassName="flex flex-col"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle className="truncate text-base">Move {docTitle} to…</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <div
          aria-busy={busy}
          className={cn("flex min-h-0 flex-1 flex-col transition-opacity", busy && "pointer-events-none opacity-60")}
        >
          <StreamTargetList
            workspaceId={workspaceId}
            onSelect={handleSelect}
            filter={isTarget}
            searchPlaceholder="Search streams…"
          />
        </div>
      </ResponsiveDialogContent>

      <ResponsiveAlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) cancel()
        }}
      >
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>Change who can read this doc?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              {pending && describeAccessChange(pending.preview)}
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void handleConfirm()
              }}
            >
              Move
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </ResponsiveDialog>
  )
}
