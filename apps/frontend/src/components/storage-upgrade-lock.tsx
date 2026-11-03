import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Progress } from "@/components/ui/progress"
import { useStorageUpgrade } from "@/hooks/use-storage-restart"

/**
 * Holds the app while storage copies every store into SQLite, once per device;
 * the copy restarts every tab when it is done. Mount through `AppToastHost`.
 */
export function StorageUpgradeLock() {
  const progress = useStorageUpgrade()
  const percent = progress?.total ? Math.min(100, Math.round((progress.copied / progress.total) * 100)) : null

  return (
    <AlertDialog open={progress !== null}>
      <AlertDialogContent
        tabIndex={-1}
        // With no action to focus, the dialog takes focus itself, so keys stop reaching the app it holds.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement).focus()
        }}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Upgrading storage</AlertDialogTitle>
          <AlertDialogDescription>Threa restarts when it's done.</AlertDialogDescription>
        </AlertDialogHeader>
        <Progress value={percent} aria-label="Storage upgrade progress" />
      </AlertDialogContent>
    </AlertDialog>
  )
}
