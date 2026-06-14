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

interface DeleteDraftConfirmDialogProps {
  /** Open while a draft is staged for deletion (e.g. `draftToDelete !== null`). */
  open: boolean
  /** Called with `false` on cancel / dismiss so the caller can clear its staged id. */
  onOpenChange: (open: boolean) => void
  /** Confirmed delete — the caller runs the actual removal. */
  onConfirm: () => void
}

/**
 * The single "Delete this draft?" confirmation for every draft-delete entry
 * point — the Drafts explorer (`pages/drafts.tsx`) and the in-composer stash
 * picker (`stashed-drafts-picker.tsx`). The delete itself is unified in
 * `deleteDraftById`; keeping the confirm shell on one path too means the two
 * surfaces can't drift (INV-35/INV-43). Renders an AlertDialog on desktop and a
 * Drawer on mobile via `ResponsiveAlertDialog`.
 */
export function DeleteDraftConfirmDialog({ open, onOpenChange, onConfirm }: DeleteDraftConfirmDialogProps) {
  return (
    <ResponsiveAlertDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveAlertDialogContent>
        <ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogTitle>Delete this draft?</ResponsiveAlertDialogTitle>
          <ResponsiveAlertDialogDescription>
            This action cannot be undone. The draft will be permanently deleted.
          </ResponsiveAlertDialogDescription>
        </ResponsiveAlertDialogHeader>
        <ResponsiveAlertDialogFooter>
          <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
          <ResponsiveAlertDialogAction onClick={onConfirm}>Delete</ResponsiveAlertDialogAction>
        </ResponsiveAlertDialogFooter>
      </ResponsiveAlertDialogContent>
    </ResponsiveAlertDialog>
  )
}
