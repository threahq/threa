import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { setupNewKey } from "@/stores/e2e-session-store"

interface PassphraseSetupModalProps {
  open: boolean
  workspaceId: string
  userId: string
  onOpenChange: (open: boolean) => void
  onSetupComplete?: () => void
}

const MIN_PASSPHRASE_LENGTH = 10

/**
 * First-time setup flow: collects a passphrase + confirmation, derives the
 * KEK, generates a fresh UIK, and persists the wrapped bundle to the server.
 * The unwrapped key stays in memory only — making the warning copy explicit
 * about the "we can't recover this" trade-off is the whole point of this
 * modal, so don't soften the language without good reason.
 */
export function PassphraseSetupModal({
  open,
  workspaceId,
  userId,
  onOpenChange,
  onSetupComplete,
}: PassphraseSetupModalProps) {
  const [passphrase, setPassphrase] = useState("")
  const [confirm, setConfirm] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const passphraseTooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH
  const mismatched = confirm.length > 0 && passphrase !== confirm
  const canSubmit =
    !submitting &&
    !passphraseTooShort &&
    !mismatched &&
    passphrase.length >= MIN_PASSPHRASE_LENGTH &&
    confirm.length > 0 &&
    acknowledged

  const reset = () => {
    setPassphrase("")
    setConfirm("")
    setAcknowledged(false)
    setSubmitting(false)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next && submitting) return
    if (!next) reset()
    onOpenChange(next)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await setupNewKey(workspaceId, userId, passphrase)
      toast.success("Encrypted scratchpads enabled")
      reset()
      onSetupComplete?.()
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to set up encryption"
      toast.error(message)
      setSubmitting(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md">
        <ResponsiveDialogHeader className="px-6 pt-6">
          <ResponsiveDialogTitle>Set up encrypted scratchpads</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Pick a passphrase you can remember. We use it to wrap a key that lives only on your devices — the server
            never sees the passphrase or the unwrapped key.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form onSubmit={handleSubmit}>
          <ResponsiveDialogBody className="space-y-4 py-4">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              <p className="font-medium">There is no recovery.</p>
              <p className="mt-1 text-destructive/90">
                If you forget this passphrase, every message you encrypt with this key becomes permanently unreadable.
                Write it down somewhere safe.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="e2e-passphrase">Passphrase</Label>
              <Input
                id="e2e-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="new-password"
                autoFocus
                placeholder={`At least ${MIN_PASSPHRASE_LENGTH} characters`}
                aria-invalid={passphraseTooShort}
              />
              {passphraseTooShort && (
                <p className="text-xs text-destructive">Use at least {MIN_PASSPHRASE_LENGTH} characters.</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="e2e-passphrase-confirm">Confirm passphrase</Label>
              <Input
                id="e2e-passphrase-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                aria-invalid={mismatched}
              />
              {mismatched && <p className="text-xs text-destructive">Passphrases don't match.</p>}
            </div>

            <div className="flex items-start gap-2 text-sm">
              <Checkbox
                id="e2e-acknowledged"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
                className="mt-0.5"
              />
              <Label htmlFor="e2e-acknowledged" className="cursor-pointer font-normal leading-snug">
                I understand that losing this passphrase means losing access to my encrypted scratchpads permanently.
              </Label>
            </div>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="gap-2 px-6 pb-6">
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? "Setting up…" : "Enable encryption"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
