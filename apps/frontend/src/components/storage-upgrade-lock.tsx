import { useRef } from "react"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Progress } from "@/components/ui/progress"
import { useStorageUpgrade } from "@/hooks/use-storage-upgrade"

/**
 * Holds the app while storage copies this device's IndexedDB rows into SQLite; a
 * device with nothing to copy never sees it. The app carries on where it was once
 * the copy is done. Mount through `AppToastHost`.
 */
export function StorageUpgradeLock() {
  const progress = useStorageUpgrade()
  const percent = progress?.total ? Math.min(100, Math.round((progress.copied / progress.total) * 100)) : null
  const focusedBefore = useRef<HTMLElement | null>(null)

  return (
    <AlertDialog open={Boolean(progress?.total)}>
      <AlertDialogContent
        tabIndex={-1}
        // With no action to focus and no trigger to return to, the dialog moves focus in and back out itself,
        // so keys stop reaching the app it holds and land where they were once an upgrade lifts without a reload.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusedBefore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          ;(event.currentTarget as HTMLElement).focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (focusedBefore.current?.isConnected) focusedBefore.current.focus()
          focusedBefore.current = null
        }}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Upgrading storage</AlertDialogTitle>
          <AlertDialogDescription>Moving this device's saved data to faster storage.</AlertDialogDescription>
        </AlertDialogHeader>
        <Progress value={percent} aria-label="Storage upgrade progress" />
      </AlertDialogContent>
    </AlertDialog>
  )
}
