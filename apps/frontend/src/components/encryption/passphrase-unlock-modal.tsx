import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { unlock } from "@/stores/e2e-session-store"

interface PassphraseUnlockModalProps {
  open: boolean
  workspaceId: string
  userId: string
  onOpenChange: (open: boolean) => void
  onUnlocked?: () => void
}

/**
 * Per-session unlock for an existing UIK. The derivation is the expensive
 * step (Argon2id) so this modal stays busy while it runs — the button label
 * reflects that so the user doesn't double-click thinking it hung.
 */
export function PassphraseUnlockModal({
  open,
  workspaceId,
  userId,
  onOpenChange,
  onUnlocked,
}: PassphraseUnlockModalProps) {
  const [passphrase, setPassphrase] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setPassphrase("")
    setSubmitting(false)
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && submitting) return
    if (!next) reset()
    onOpenChange(next)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting || passphrase.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      await unlock(workspaceId, userId, passphrase)
      toast.success("Encrypted scratchpads unlocked")
      reset()
      onUnlocked?.()
      onOpenChange(false)
    } catch {
      setError("That passphrase didn't unlock the bundle. Try again.")
      setSubmitting(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md">
        <ResponsiveDialogHeader className="px-6 pt-6">
          <ResponsiveDialogTitle>Unlock encrypted scratchpads</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Enter your passphrase to load the encryption key for this session. It's only kept in memory and is dropped
            when you sign out or lock the session.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit}>
          <ResponsiveDialogBody className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="e2e-unlock-passphrase">Passphrase</Label>
              <Input
                id="e2e-unlock-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="current-password"
                autoFocus
                aria-invalid={error !== null}
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="gap-2 px-6 pb-6">
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || passphrase.length === 0}>
              {submitting ? "Unlocking…" : "Unlock"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
