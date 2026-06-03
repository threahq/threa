import { useState } from "react"
import { toast } from "sonner"
import { Fingerprint } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { unlockWithBiometric, useE2eSession } from "@/stores/e2e-session-store"

interface BiometricUnlockModalProps {
  open: boolean
  workspaceId: string
  userId: string
  onOpenChange: (open: boolean) => void
  onUnlocked?: () => void
  /** Fall back to passphrase entry (biometric unavailable / failed / declined). */
  onUsePassphrase: () => void
}

/**
 * Quick-unlock for a device with biometric (WebAuthn PRF) set. The single button
 * triggers the OS biometric prompt from the user's click (a gesture is required
 * for WebAuthn); on success the session unlocks. Any failure surfaces the
 * session's inline error and leaves the passphrase fallback available.
 */
export function BiometricUnlockModal({
  open,
  workspaceId,
  userId,
  onOpenChange,
  onUnlocked,
  onUsePassphrase,
}: BiometricUnlockModalProps) {
  const session = useE2eSession(workspaceId, userId)
  const [submitting, setSubmitting] = useState(false)

  const handleUnlock = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await unlockWithBiometric(workspaceId, userId)
      toast.success("Encrypted scratchpads unlocked")
      // The modal stays mounted under the provider, so clear the busy flag or a
      // reopen would render a stuck "Waiting for biometrics…" button.
      setSubmitting(false)
      onUnlocked?.()
      onOpenChange(false)
    } catch {
      // The store set the inline error; let the user retry or use the passphrase.
      setSubmitting(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-sm">
        <ResponsiveDialogHeader className="px-6 pt-6">
          <ResponsiveDialogTitle>Unlock with biometrics</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Use this device's fingerprint or face unlock to reopen your encrypted scratchpads.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="flex flex-col items-center gap-3 py-6">
          <Button type="button" size="lg" className="gap-2" disabled={submitting} onClick={handleUnlock}>
            <Fingerprint className="h-5 w-5" />
            {submitting ? "Waiting for biometrics…" : "Unlock with biometrics"}
          </Button>
          {session.error && <p className="text-center text-xs text-destructive">{session.error}</p>}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter className="px-6 pb-6">
          <Button type="button" variant="ghost" onClick={onUsePassphrase} disabled={submitting}>
            Use passphrase
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
