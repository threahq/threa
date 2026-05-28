import { Lock, LockOpen, ShieldPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useE2eUnlockOptional, type E2eUnlockContextValue } from "./e2e-unlock-provider"

type EncryptionAction =
  | { kind: "setup"; unlock: E2eUnlockContextValue }
  | { kind: "unlock"; unlock: E2eUnlockContextValue; pending: boolean }

/**
 * Decides the encryption call-to-action for a stream surface, or null when
 * none is warranted: the stream isn't encrypted, the provider is absent
 * (unit harnesses), the user isn't resolved yet, the session is already
 * unlocked, or we're still hydrating (`unknown`) and shouldn't flash a CTA.
 *
 * Both the header button and the composer notice share this so "where can I
 * unlock?" has one answer per state instead of drifting per surface.
 */
function useStreamEncryptionAction(workspaceId: string, encrypted: boolean): EncryptionAction | null {
  const unlock = useE2eUnlockOptional()
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")

  if (!encrypted || !unlock || !userId) return null
  switch (session.status) {
    case "no-key":
      return { kind: "setup", unlock }
    case "locked":
    case "unlocking":
      return { kind: "unlock", unlock, pending: session.status === "unlocking" }
    default:
      // `unlocked` (nothing to do) and `unknown` (still loading) both render nothing.
      return null
  }
}

/**
 * Inline unlock affordance for the stream header — sits beside the "Encrypted"
 * pill so a locked stream can be unlocked in place, without detouring through
 * Settings. Renders nothing for unencrypted or already-unlocked streams.
 */
export function StreamHeaderEncryptionAction({ workspaceId, encrypted }: { workspaceId: string; encrypted: boolean }) {
  const action = useStreamEncryptionAction(workspaceId, encrypted)
  if (!action) return null

  if (action.kind === "setup") {
    return (
      <Button size="sm" variant="outline" className="h-7 gap-1 px-2" onClick={() => action.unlock.openSetup()}>
        <ShieldPlus className="h-3.5 w-3.5" />
        Set up encryption
      </Button>
    )
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1 px-2"
      disabled={action.pending}
      onClick={() => action.unlock.openUnlock()}
    >
      <LockOpen className="h-3.5 w-3.5" />
      {action.pending ? "Unlocking…" : "Unlock"}
    </Button>
  )
}

/**
 * Composer banner shown above the message input when an encrypted stream is
 * locked (or not yet set up). Encrypting a message needs the in-memory key, so
 * this gives the user a one-click way to unlock right where they're about to
 * type. Renders nothing once unlocked or for unencrypted streams.
 */
export function ComposerEncryptionNotice({
  workspaceId,
  encrypted,
  className,
}: {
  workspaceId: string
  encrypted: boolean
  className?: string
}) {
  const action = useStreamEncryptionAction(workspaceId, encrypted)
  if (!action) return null

  const isSetup = action.kind === "setup"
  return (
    <div
      className={cn(
        "mb-2 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs",
        className
      )}
    >
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Lock className="h-3.5 w-3.5 shrink-0" />
        {isSetup
          ? "Set up encryption to write in this scratchpad."
          : "This scratchpad is encrypted. Unlock it to read and write messages."}
      </span>
      {isSetup ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 px-2"
          onClick={() => action.unlock.openSetup()}
        >
          <ShieldPlus className="h-3.5 w-3.5" />
          Set up
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 px-2"
          disabled={action.pending}
          onClick={() => action.unlock.openUnlock()}
        >
          <LockOpen className="h-3.5 w-3.5" />
          {action.pending ? "Unlocking…" : "Unlock"}
        </Button>
      )}
    </div>
  )
}
