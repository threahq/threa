import { useState } from "react"
import type { Visibility } from "@threahq/types"
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
import { VisibilityPicker } from "@/components/ui/visibility-picker"
import { Button } from "@/components/ui/button"
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
  const { isTarget, canLift, pick, pending, confirm, cancel, reset, busy } = docMove
  const [lifting, setLifting] = useState(false)
  const [visibility, setVisibility] = useState<Visibility>("private")

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      reset()
      setLifting(false)
      setVisibility("private")
    }
    onOpenChange(next)
  }

  const handleSelect = async (toStreamId: string) => {
    if (busy) return
    if (await pick({ toStreamId })) handleOpenChange(false)
  }

  const handleLift = async () => {
    if (busy) return
    if (await pick({ toStreamId: null, visibility })) handleOpenChange(false)
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
          {lifting ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <VisibilityPicker value={visibility} onChange={setVisibility} disabled={busy} />
              <div className="mt-auto flex justify-end gap-2">
                <Button variant="outline" disabled={busy} onClick={() => setLifting(false)}>
                  Back
                </Button>
                <Button disabled={busy} onClick={() => void handleLift()}>
                  Move
                </Button>
              </div>
            </div>
          ) : (
            <>
              {canLift && (
                <div className="border-b p-3">
                  <Button variant="outline" className="w-full" disabled={busy} onClick={() => setLifting(true)}>
                    Top level
                  </Button>
                </div>
              )}
              <StreamTargetList
                workspaceId={workspaceId}
                onSelect={handleSelect}
                filter={isTarget}
                includeDocHosts
                searchPlaceholder="Search streams…"
              />
            </>
          )}
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
