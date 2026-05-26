import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { Lock, LockOpen, ShieldAlert, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { useAuth } from "@/auth"
import { Button } from "@/components/ui/button"
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
import { e2eKeysApi } from "@/api/e2e-keys"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { lock, loadE2eKeyForUser, useE2eSession } from "@/stores/e2e-session-store"
import { PassphraseSetupModal } from "./passphrase-setup-modal"
import { PassphraseUnlockModal } from "./passphrase-unlock-modal"

interface EncryptedScratchpadsSectionProps {
  workspaceId: string
  userId: string
}

function EncryptedScratchpadsSectionInner({ workspaceId, userId }: EncryptedScratchpadsSectionProps) {
  const session = useE2eSession(workspaceId, userId)
  const [setupOpen, setSetupOpen] = useState(false)
  const [unlockOpen, setUnlockOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)

  useEffect(() => {
    void loadE2eKeyForUser(workspaceId, userId)
  }, [workspaceId, userId])

  const handleRevoke = async () => {
    setRevoking(true)
    try {
      await e2eKeysApi.revoke(workspaceId)
      lock(workspaceId, userId)
      // Re-load so the local cache row gets cleared and status flips to no-key.
      await loadE2eKeyForUser(workspaceId, userId)
      toast.success("Encryption key revoked")
      setRevokeOpen(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to revoke key"
      toast.error(message)
    } finally {
      setRevoking(false)
    }
  }

  const statusBadge = (() => {
    switch (session.status) {
      case "unlocked":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3 w-3" />
            Unlocked
          </span>
        )
      case "locked":
      case "unlocking":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
            <Lock className="h-3 w-3" />
            {session.status === "unlocking" ? "Unlocking…" : "Locked"}
          </span>
        )
      case "no-key":
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <ShieldAlert className="h-3 w-3" />
            Not set up
          </span>
        )
      case "unknown":
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            Checking…
          </span>
        )
    }
  })()

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Encrypted scratchpads</h3>
        {statusBadge}
      </div>
      <p className="text-sm text-muted-foreground">
        Scratchpad content is encrypted on this device with a key wrapped by your passphrase. Threa never sees the
        unwrapped key or the passphrase — losing the passphrase means losing access to encrypted content forever.
      </p>

      {session.status === "no-key" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setSetupOpen(true)}>
            Set up encryption
          </Button>
        </div>
      )}

      {(session.status === "locked" || session.status === "unlocking") && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setUnlockOpen(true)} disabled={session.status === "unlocking"}>
            <LockOpen className="mr-1 h-4 w-4" />
            Unlock
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRevokeOpen(true)}>
            Revoke key
          </Button>
        </div>
      )}

      {session.status === "unlocked" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => lock(workspaceId, userId)}>
            <Lock className="mr-1 h-4 w-4" />
            Lock now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRevokeOpen(true)}>
            Revoke key
          </Button>
        </div>
      )}

      <PassphraseSetupModal open={setupOpen} workspaceId={workspaceId} userId={userId} onOpenChange={setSetupOpen} />
      <PassphraseUnlockModal open={unlockOpen} workspaceId={workspaceId} userId={userId} onOpenChange={setUnlockOpen} />

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
    </section>
  )
}

/**
 * Settings section for the user's E2E identity key. Renders a status row +
 * the appropriate action (setup / unlock / lock / revoke) and owns the
 * passphrase modals. Resolves the workspace user id from the workspace cache
 * so the store is keyed by `usr_xxx`, not the WorkOS id.
 */
export function EncryptedScratchpadsSection() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { user } = useAuth()
  const workspaceUsers = useWorkspaceUsers(workspaceId ?? "")
  const currentUser = user ? (workspaceUsers.find((u) => u.workosUserId === user.id) ?? null) : null

  if (!workspaceId || !currentUser) return null

  return <EncryptedScratchpadsSectionInner workspaceId={workspaceId} userId={currentUser.id} />
}
