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
import { describeAccessChange, type useMoveDoc } from "./use-move-doc"

interface DocMoveDialogProps {
  workspaceId: string
  docTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  docMove: ReturnType<typeof useMoveDoc>
}

/** Pick the doc's new host; a move that changes who can read the doc asks first. */
export function DocMoveDialog({ workspaceId, docTitle, open, onOpenChange, docMove }: DocMoveDialogProps) {
  const { isTarget, pick, pending, confirm, cancel, busy } = docMove

  const handleSelect = async (toStreamId: string) => {
    if (busy) return
    if (await pick(toStreamId)) onOpenChange(false)
  }

  const handleConfirm = async () => {
    if (await confirm()) onOpenChange(false)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        className="overflow-hidden p-0"
        desktopClassName="sm:max-w-lg"
        drawerClassName="flex flex-col"
      >
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle className="truncate text-base">Move {docTitle} to…</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <StreamTargetList
          workspaceId={workspaceId}
          onSelect={handleSelect}
          filter={isTarget}
          searchPlaceholder="Search streams…"
        />
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
