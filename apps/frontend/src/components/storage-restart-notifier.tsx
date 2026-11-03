import { useEffect } from "react"
import { toast } from "@/lib/sonner-module"
import { useStorageRestart } from "@/hooks/use-storage-restart"

const TOAST_ID = "storage-restart"

/**
 * The storage flag asks for a mode only a restart of every tab can switch to.
 * Like an app update, the restart is the user's to take; waving the notice off
 * keeps this session as it is. Mount through `AppToastHost`. Unlike the update
 * notice it stays in the E2E build: only a flag change raises it, and the spec
 * that changes the flag takes the restart.
 */
export function StorageRestartNotifier() {
  const { pending, restart, dismiss } = useStorageRestart()

  useEffect(() => {
    if (!pending) {
      toast.dismiss(TOAST_ID)
      return
    }
    toast("Storage upgrade ready", {
      id: TOAST_ID,
      description: "Restart Threa to switch to the faster storage.",
      duration: Infinity,
      action: {
        label: "Restart",
        onClick: (event) => {
          event.preventDefault()
          restart()
        },
      },
      onDismiss: dismiss,
    })
  }, [pending, restart, dismiss])

  return null
}
