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
  /**
   * Number of drafts being removed. Omit (or `1`) for the single-draft delete;
   * pass the batch size for the Drafts explorer's bulk delete so the copy reads
   * "Delete N drafts?".
   */
  count?: number
}

/**
 * The single "Delete this draft?" confirmation for every draft-delete entry
 * point — the Drafts explorer (`pages/drafts.tsx`, single and bulk delete) and
 * the in-composer stash picker (`stashed-drafts-picker.tsx`). The delete itself
 * is unified in `deleteDraftById`; keeping the confirm shell on one path too
 * means the surfaces can't drift (INV-35/INV-43). Renders an AlertDialog on
 * desktop and a Drawer on mobile via `ResponsiveAlertDialog`.
 */
export function DeleteDraftConfirmDialog({ open, onOpenChange, onConfirm, count }: DeleteDraftConfirmDialogProps) {
  const isBulk = count != null && count > 1
  const title = isBulk ? `Delete ${count} drafts?` : "Delete this draft?"
  const description = isBulk
    ? `This action cannot be undone. ${count} drafts will be permanently deleted.`
    : "This action cannot be undone. The draft will be permanently deleted."

  return (
    <ResponsiveAlertDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveAlertDialogContent>
        <ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogTitle>{title}</ResponsiveAlertDialogTitle>
          <ResponsiveAlertDialogDescription>{description}</ResponsiveAlertDialogDescription>
        </ResponsiveAlertDialogHeader>
        <ResponsiveAlertDialogFooter>
          <ResponsiveAlertDialogCancel>Cancel</ResponsiveAlertDialogCancel>
          <ResponsiveAlertDialogAction onClick={onConfirm}>Delete</ResponsiveAlertDialogAction>
        </ResponsiveAlertDialogFooter>
      </ResponsiveAlertDialogContent>
    </ResponsiveAlertDialog>
  )
}
