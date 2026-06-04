import { useState } from "react"
import { toast } from "sonner"
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
import { isValidPin } from "@/lib/crypto/pin-device-key"
import { unlockWithPin, useE2eSession } from "@/stores/e2e-session-store"
import { PinInput } from "./pin-input"

interface PinUnlockModalProps {
  open: boolean
  workspaceId: string
  userId: string
  onOpenChange: (open: boolean) => void
  onUnlocked?: () => void
  /** Fall back to passphrase entry (e.g. the user forgot the PIN). */
  onUsePassphrase: () => void
}

/**
 * Quick-unlock for a device that has a PIN set. Mirrors the passphrase unlock
 * modal but takes the 6–8 digit PIN; the store counts wrong attempts and, after
 * the lockout, forgets the PIN and surfaces a "use your passphrase" error. The
 * inline error comes straight off the session so attempt-count messaging stays
 * in one place. Submits automatically once all digits are entered.
 */
export function PinUnlockModal({ open, workspaceId, userId, onOpenChange, onUnlocked, onUsePassphrase }: PinUnlockModalProps) {
  const session = useE2eSession(workspaceId, userId)
  const [pin, setPin] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    setPin("")
    setSubmitting(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && submitting) return
    if (!next) reset()
    onOpenChange(next)
  }

  const submit = async (candidate: string) => {
    if (submitting || !isValidPin(candidate)) return
    setSubmitting(true)
    try {
      await unlockWithPin(workspaceId, userId, candidate)
      toast.success("Encrypted scratchpads unlocked")
      reset()
      onUnlocked?.()
      onOpenChange(false)
    } catch {
      // The store set the inline error (wrong PIN + attempts left, or lockout).
      // Clear the entry so the user can retype; if the lockout wiped the PIN the
      // caller swaps to the passphrase modal off `session.pinProtected`.
      setPin("")
      setSubmitting(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-sm">
        <ResponsiveDialogHeader className="px-6 pt-6">
          <ResponsiveDialogTitle>Enter your PIN</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Unlock encrypted scratchpads on this device with your quick-unlock PIN.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit(pin)
          }}
        >
          <ResponsiveDialogBody className="space-y-3 py-4">
            <PinInput
              value={pin}
              onChange={setPin}
              onComplete={(v) => void submit(v)}
              disabled={submitting}
              autoFocus
              ariaLabel="Quick-unlock PIN"
            />
            {session.error && <p className="text-center text-xs text-destructive">{session.error}</p>}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="gap-2 px-6 pb-6">
            <Button type="button" variant="ghost" onClick={onUsePassphrase} disabled={submitting}>
              Use passphrase
            </Button>
            <Button type="submit" disabled={submitting || !isValidPin(pin)}>
              {submitting ? "Unlocking…" : "Unlock"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
