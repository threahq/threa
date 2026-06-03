import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { cn } from "@/lib/utils"
import { setupNewKey } from "@/stores/e2e-session-store"
import { scorePassphrase, type PassphraseScore } from "./passphrase-strength"
import { RevealablePassphraseInput } from "./revealable-passphrase-input"
import { PinInput, PIN_LENGTH } from "./pin-input"
import { isValidPin } from "@/lib/crypto/pin-device-key"

interface PassphraseSetupModalProps {
  open: boolean
  workspaceId: string
  userId: string
  /** Initial checked state of "keep me unlocked on this device". */
  defaultTrustDevice?: boolean
  onOpenChange: (open: boolean) => void
  onSetupComplete?: () => void
}

const MIN_PASSPHRASE_LENGTH = 10

const STRENGTH_PIP_CLASSES = [
  "bg-destructive",
  "bg-destructive/80",
  "bg-amber-500",
  "bg-emerald-500/80",
  "bg-emerald-500",
] as const

function PassphraseStrengthMeter({ score }: { score: PassphraseScore }) {
  return (
    <div className="space-y-1">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={cn("h-1 flex-1 rounded-full", i <= score.level ? STRENGTH_PIP_CLASSES[score.level] : "bg-muted")}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        <span className="font-medium text-foreground">{score.label}.</span> {score.description}
      </p>
    </div>
  )
}

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
  defaultTrustDevice = true,
  onOpenChange,
  onSetupComplete,
}: PassphraseSetupModalProps) {
  const [passphrase, setPassphrase] = useState("")
  const [confirm, setConfirm] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)
  const [trustDevice, setTrustDevice] = useState(defaultTrustDevice)
  const [pin, setPin] = useState("")
  const [submitting, setSubmitting] = useState(false)

  // Reset the toggle to the caller's default each time the modal opens.
  useEffect(() => {
    if (open) setTrustDevice(defaultTrustDevice)
  }, [open, defaultTrustDevice])

  const passphraseTooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH
  const mismatched = confirm.length > 0 && passphrase !== confirm
  // The PIN is optional, but a partial/invalid entry blocks submit so it can't
  // be silently dropped. Only offered alongside device trust.
  const pinInvalid = trustDevice && pin.length > 0 && !isValidPin(pin)
  const strength = useMemo(() => scorePassphrase(passphrase), [passphrase])
  const canSubmit =
    !submitting &&
    !passphraseTooShort &&
    !mismatched &&
    !pinInvalid &&
    passphrase.length >= MIN_PASSPHRASE_LENGTH &&
    confirm.length > 0 &&
    acknowledged

  const reset = () => {
    setPassphrase("")
    setConfirm("")
    setAcknowledged(false)
    setTrustDevice(defaultTrustDevice)
    setPin("")
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
      const devicePin = trustDevice && isValidPin(pin) ? pin : undefined
      const result = await setupNewKey(workspaceId, userId, passphrase, { trustDevice, pin: devicePin })
      if (result?.trustRequested && !result.trustPersisted) {
        toast.warning(
          "Encryption enabled, but couldn't keep you unlocked on this device. You'll need your passphrase next time."
        )
      } else {
        toast.success("Encrypted scratchpads enabled")
      }
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
              <RevealablePassphraseInput
                id="e2e-passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="new-password"
                autoFocus
                placeholder={`At least ${MIN_PASSPHRASE_LENGTH} characters`}
                aria-invalid={passphraseTooShort}
              />
              {passphrase.length > 0 && <PassphraseStrengthMeter score={strength} />}
              {passphraseTooShort && (
                <p className="text-xs text-destructive">Use at least {MIN_PASSPHRASE_LENGTH} characters.</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="e2e-passphrase-confirm">Confirm passphrase</Label>
              <RevealablePassphraseInput
                id="e2e-passphrase-confirm"
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

            <div className="flex items-start gap-2 text-sm">
              <Checkbox
                id="e2e-setup-trust-device"
                checked={trustDevice}
                onCheckedChange={(checked) => setTrustDevice(checked === true)}
                className="mt-0.5"
              />
              <Label htmlFor="e2e-setup-trust-device" className="cursor-pointer font-normal leading-snug">
                Keep me unlocked on this device
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Skips the passphrase next time on this device. Don't use on shared or public computers.
                </span>
              </Label>
            </div>

            {trustDevice && (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                <Label className="font-normal">
                  Quick-unlock PIN <span className="text-muted-foreground">(optional)</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Set a {PIN_LENGTH}-digit PIN to reopen on this device without your full passphrase. The PIN never
                    leaves this device.
                  </span>
                </Label>
                <PinInput value={pin} onChange={setPin} disabled={submitting} ariaLabel="Quick-unlock PIN" />
                {pinInvalid && <p className="text-xs text-destructive">Enter all {PIN_LENGTH} digits, or leave blank.</p>}
              </div>
            )}
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
