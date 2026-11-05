import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { CircleAlert, Fingerprint, KeyRound, Lock, LockOpen, Plus } from "lucide-react"
import { toast } from "sonner"
import { useAuth } from "@/auth"
import { Button } from "@/components/ui/button"
import {
  SETTING_CONTROL_HEIGHT,
  SettingActions,
  SettingControlSkeleton,
  SettingDependents,
  SettingRow,
  SwitchSetting,
  settingIds,
} from "@/components/settings/setting-primitives"
import { settingDef } from "@/components/settings/settings-registry"
import { cn } from "@/lib/utils"
import { useCreateEncryptedScratchpad } from "@/hooks/use-create-encrypted-scratchpad"
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
import { useWorkspaceUsers } from "@/stores/workspace-store"
import {
  enrollDeviceBiometric,
  enrollDevicePin,
  getDeviceUnlockMethod,
  lock,
  revokeKeyForUser,
  setDeviceTrust,
  useE2eSession,
  type DeviceUnlockMethod,
  type E2eSessionStatus,
} from "@/stores/e2e-session-store"
import { isValidPin } from "@/lib/crypto/pin-device-key"
import { isPlatformAuthenticatorAvailable, registerDeviceBiometric } from "@/lib/crypto/webauthn-device-key"
import { PinInput } from "./pin-input"
import { useE2eUnlock } from "./e2e-unlock-provider"

const UNLOCK_METHOD_LABEL: Record<DeviceUnlockMethod, string> = {
  none: "You'll enter your passphrase each time on this device.",
  remembered: "Unlocks automatically on this device — no passphrase prompt.",
  pin: "Unlocks with your 6-digit PIN on this device.",
  biometric: "Unlocks with this device's fingerprint or face.",
}

const STATE_SENTENCE: Record<E2eSessionStatus, string> = {
  unknown: "Checking…",
  "no-key": "Not set up.",
  locked: "Locked.",
  unlocking: "Unlocking…",
  unlocked: "Unlocked on this device.",
}

function encryptionDescription(status: E2eSessionStatus) {
  return `${STATE_SENTENCE[status]} ${settingDef("encryption").description}`
}

const LOCKED_REASON: Record<Exclude<E2eSessionStatus, "unlocked" | "unknown">, string> = {
  "no-key": "Set up encryption first.",
  locked: "Unlock first.",
  unlocking: "Unlock first.",
}

const PASSPHRASE_WARNING = "Your passphrase is the only recovery. Lose it and encrypted content can't be opened again."

interface EncryptionKeysProps {
  workspaceId: string
  userId: string
}

function EncryptionKeys({ workspaceId, userId }: EncryptionKeysProps) {
  const session = useE2eSession(workspaceId, userId)
  const { openSetup, openUnlock } = useE2eUnlock()
  const navigate = useNavigate()
  const createEncryptedScratchpad = useCreateEncryptedScratchpad(workspaceId, userId)
  const [creating, setCreating] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [trustPending, setTrustPending] = useState(false)
  // Quick-unlock method management (only meaningful while unlocked + trusted).
  const [unlockMethod, setUnlockMethod] = useState<DeviceUnlockMethod>("none")
  const [biometricAvailable, setBiometricAvailable] = useState(false)
  const [pinEditorOpen, setPinEditorOpen] = useState(false)
  const [pin, setPin] = useState("")
  const [methodPending, setMethodPending] = useState(false)

  const isUnlocked = session.status === "unlocked"

  const refreshUnlockMethod = useCallback(async () => {
    setUnlockMethod(await getDeviceUnlockMethod(workspaceId, userId))
  }, [workspaceId, userId])

  // Load the current device method + probe biometric availability whenever the
  // session becomes unlocked (the only state where the method block renders).
  useEffect(() => {
    if (!isUnlocked) return
    let cancelled = false
    void getDeviceUnlockMethod(workspaceId, userId).then((m) => {
      if (!cancelled) setUnlockMethod(m)
    })
    void isPlatformAuthenticatorAvailable().then((ok) => {
      if (!cancelled) setBiometricAvailable(ok)
    })
    return () => {
      cancelled = true
    }
  }, [isUnlocked, workspaceId, userId])

  const handleTrustChange = async (next: boolean) => {
    setTrustPending(true)
    try {
      await setDeviceTrust(workspaceId, userId, next)
      await refreshUnlockMethod()
      if (!next) setPinEditorOpen(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update device trust"
      toast.error(message)
    } finally {
      setTrustPending(false)
    }
  }

  const handleSetPin = async () => {
    if (methodPending || !isValidPin(pin)) return
    setMethodPending(true)
    try {
      await enrollDevicePin(workspaceId, userId, pin)
      setPin("")
      setPinEditorOpen(false)
      await refreshUnlockMethod()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't set the PIN")
    } finally {
      setMethodPending(false)
    }
  }

  const handleUseBiometric = async () => {
    if (methodPending) return
    setMethodPending(true)
    try {
      const registration = await registerDeviceBiometric(userId)
      await enrollDeviceBiometric(workspaceId, userId, registration)
      setPinEditorOpen(false)
      await refreshUnlockMethod()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't set up biometric unlock")
    } finally {
      setMethodPending(false)
    }
  }

  // Drop a PIN/biometric gate back to plain auto-resume without re-entering the
  // passphrase — the in-memory key is re-sealed under the device AES key.
  const handleUseAutomatic = async () => {
    if (methodPending) return
    setMethodPending(true)
    try {
      await setDeviceTrust(workspaceId, userId, true)
      setPinEditorOpen(false)
      await refreshUnlockMethod()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the unlock method")
    } finally {
      setMethodPending(false)
    }
  }

  const handleCreateScratchpad = async () => {
    setCreating(true)
    try {
      const streamId = await createEncryptedScratchpad(true)
      navigate(`/w/${workspaceId}/s/${streamId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create the encrypted scratchpad")
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async () => {
    setRevoking(true)
    try {
      await revokeKeyForUser(workspaceId, userId)
      setRevokeOpen(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to revoke key"
      toast.error(message)
    } finally {
      setRevoking(false)
    }
  }

  const status = session.status
  let actions: ReactNode = null
  if (status === "no-key") {
    actions = (
      <Button
        variant="outline"
        size="sm"
        className={SETTING_CONTROL_HEIGHT}
        onClick={() => openSetup({ defaultTrustDevice: false })}
      >
        Set up encryption
      </Button>
    )
  } else if (status === "locked" || status === "unlocking") {
    actions = (
      <SettingActions>
        <Button
          variant="outline"
          size="sm"
          className={SETTING_CONTROL_HEIGHT}
          onClick={() => openUnlock({ defaultTrustDevice: false })}
          disabled={status === "unlocking"}
        >
          <LockOpen aria-hidden />
          Unlock
        </Button>
        <RevokeButton onClick={() => setRevokeOpen(true)} />
      </SettingActions>
    )
  } else if (status === "unlocked") {
    actions = (
      <SettingActions>
        <Button
          variant="outline"
          size="sm"
          className={SETTING_CONTROL_HEIGHT}
          disabled={creating}
          onClick={() => void handleCreateScratchpad()}
        >
          <Plus aria-hidden />
          New encrypted scratchpad
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={SETTING_CONTROL_HEIGHT}
          onClick={() => void lock(workspaceId, userId)}
        >
          <Lock aria-hidden />
          Lock now
        </Button>
        <RevokeButton onClick={() => setRevokeOpen(true)} />
      </SettingActions>
    )
  }

  const lockedReason = status === "unlocked" || status === "unknown" ? undefined : LOCKED_REASON[status]
  const methodReason =
    lockedReason ?? (isUnlocked && !session.deviceTrusted ? "Turn on Keep me unlocked first." : undefined)
  const methodIds = settingIds("encryption-unlock-method")

  return (
    <>
      <SettingRow
        setting="encryption"
        labelFor={false}
        description={encryptionDescription(status)}
        notice={PASSPHRASE_WARNING}
        noticeIcon={CircleAlert}
        control={actions}
      />

      <SettingDependents parent="encryption">
        <SwitchSetting
          setting="encryption-keep-unlocked"
          checked={isUnlocked && session.deviceTrusted}
          disabled={trustPending}
          loading={status === "unknown"}
          inactive={lockedReason}
          onCheckedChange={(next) => void handleTrustChange(next)}
        />
        <SettingRow
          setting="encryption-unlock-method"
          labelFor={false}
          description={
            methodReason || status === "unknown" ? undefined : (
              <span aria-live="polite">{UNLOCK_METHOD_LABEL[unlockMethod]}</span>
            )
          }
          inactive={methodReason}
          control={
            status === "unknown" ? (
              <SettingControlSkeleton className="w-28" />
            ) : (
              <SettingActions>
                <Button
                  variant="outline"
                  size="sm"
                  className={SETTING_CONTROL_HEIGHT}
                  disabled={methodPending || !!methodReason}
                  aria-describedby={methodReason ? methodIds.reason : undefined}
                  aria-expanded={pinEditorOpen}
                  onClick={() => setPinEditorOpen((open) => !open)}
                >
                  <KeyRound aria-hidden />
                  {unlockMethod === "pin" ? "Change PIN" : "Set a PIN"}
                </Button>
                {!methodReason && biometricAvailable && unlockMethod !== "biometric" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className={SETTING_CONTROL_HEIGHT}
                    disabled={methodPending}
                    onClick={() => void handleUseBiometric()}
                  >
                    <Fingerprint aria-hidden />
                    Use biometrics
                  </Button>
                )}
                {!methodReason && unlockMethod !== "remembered" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className={SETTING_CONTROL_HEIGHT}
                    disabled={methodPending}
                    onClick={() => void handleUseAutomatic()}
                  >
                    Unlock automatically
                  </Button>
                )}
              </SettingActions>
            )
          }
        >
          {pinEditorOpen && !methodReason && (
            <div className="space-y-3">
              <PinInput value={pin} onChange={setPin} disabled={methodPending} ariaLabel="New device PIN" />
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className={SETTING_CONTROL_HEIGHT}
                  disabled={methodPending}
                  onClick={() => {
                    setPinEditorOpen(false)
                    setPin("")
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className={SETTING_CONTROL_HEIGHT}
                  disabled={methodPending || !isValidPin(pin)}
                  onClick={() => void handleSetPin()}
                >
                  {methodPending ? "Saving…" : "Save PIN"}
                </Button>
              </div>
            </div>
          )}
        </SettingRow>
      </SettingDependents>

      <ResponsiveAlertDialog open={revokeOpen} onOpenChange={(next) => !revoking && setRevokeOpen(next)}>
        <ResponsiveAlertDialogContent>
          <ResponsiveAlertDialogHeader>
            <ResponsiveAlertDialogTitle>Revoke encryption key?</ResponsiveAlertDialogTitle>
            <ResponsiveAlertDialogDescription>
              Any content already encrypted to this key will become permanently unreadable on every device. You'll need
              to set up a new passphrase afterwards.
            </ResponsiveAlertDialogDescription>
          </ResponsiveAlertDialogHeader>
          <ResponsiveAlertDialogFooter>
            <ResponsiveAlertDialogCancel disabled={revoking}>Keep key</ResponsiveAlertDialogCancel>
            <ResponsiveAlertDialogAction
              onClick={handleRevoke}
              disabled={revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoking ? "Revoking…" : "Revoke"}
            </ResponsiveAlertDialogAction>
          </ResponsiveAlertDialogFooter>
        </ResponsiveAlertDialogContent>
      </ResponsiveAlertDialog>
    </>
  )
}

function RevokeButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("text-destructive hover:text-destructive", SETTING_CONTROL_HEIGHT)}
      onClick={onClick}
    >
      Revoke key
    </Button>
  )
}

/**
 * The settings row for the viewer's E2E identity key in this workspace: status,
 * setup / unlock / lock / revoke, this device's quick unlock, and creating an
 * encrypted scratchpad. Resolves the workspace user id from the workspace cache
 * so the store is keyed by `usr_xxx`, not the WorkOS id.
 */
export function EncryptionKeysSetting() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { user } = useAuth()
  const workspaceUsers = useWorkspaceUsers(workspaceId ?? "")
  const currentUser = user ? (workspaceUsers.find((u) => u.workosUserId === user.id) ?? null) : null

  if (!workspaceId || !currentUser) {
    return (
      <>
        <SettingRow
          setting="encryption"
          labelFor={false}
          description={encryptionDescription("unknown")}
          notice={PASSPHRASE_WARNING}
          noticeIcon={CircleAlert}
        />
        <SettingDependents parent="encryption">
          <SwitchSetting setting="encryption-keep-unlocked" checked={false} loading onCheckedChange={() => {}} />
          <SettingRow
            setting="encryption-unlock-method"
            labelFor={false}
            control={<SettingControlSkeleton className="w-28" />}
          />
        </SettingDependents>
      </>
    )
  }

  return <EncryptionKeys workspaceId={workspaceId} userId={currentUser.id} />
}
