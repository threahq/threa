import { Loader2, Lock, LockOpen, ShieldPlus } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useE2eUnlockOptional } from "./e2e-unlock-provider"

/**
 * Full-page gate for an encrypted scratchpad. While the viewer's E2E session is
 * locked (or not yet set up), the stream's timeline and composer are replaced
 * entirely by a single unlock/setup page — rather than mounting the timeline with
 * per-message "locked" placeholders and a composer banner. Once unlocked, the
 * children render unchanged and the gate is invisible.
 *
 * The session is per-(workspace, user), not per-stream, so unlocking here unlocks
 * every encrypted scratchpad at once; the provider mounted at the workspace layer
 * drives the load, so `unknown` is a brief hydration window, not a dead end.
 *
 * Passes children through verbatim for non-encrypted streams or when the unlock
 * provider is absent (unit harnesses), so callers can wrap unconditionally.
 */
export function StreamEncryptionGate({
  workspaceId,
  encrypted,
  children,
}: {
  workspaceId: string
  encrypted: boolean
  children: ReactNode
}) {
  const unlock = useE2eUnlockOptional()
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")

  if (!encrypted || !unlock) return <>{children}</>

  // For an encrypted stream we never reveal the timeline until we know the
  // session is unlocked: while the user is unresolved or the session is still
  // hydrating, show a quiet spinner instead of flashing the gate or placeholders.
  if (!userId || session.status === "unknown") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Checking encryption" />
      </div>
    )
  }

  if (session.status === "unlocked") return <>{children}</>

  if (session.status === "no-key") {
    return <GatePanel kind="setup" onAction={() => unlock.openSetup()} />
  }
  return (
    <GatePanel kind="unlock" pending={session.status === "unlocking"} onAction={() => unlock.openUnlock()} />
  )
}

function GatePanel({
  kind,
  pending,
  onAction,
}: {
  kind: "setup" | "unlock"
  pending?: boolean
  onAction: () => void
}) {
  const isSetup = kind === "setup"
  let buttonLabel = "Set up encryption"
  if (!isSetup) buttonLabel = pending ? "Unlocking…" : "Unlock"
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        {isSetup ? (
          <ShieldPlus className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        ) : (
          <Lock className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">
          {isSetup ? "Set up encryption" : "This scratchpad is encrypted"}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {isSetup
            ? "Create your encryption key to read and write in encrypted scratchpads."
            : "Unlock with your passphrase to read and write messages. Your messages stay encrypted on the server."}
        </p>
      </div>
      <Button onClick={onAction} disabled={pending} className="gap-1.5">
        {isSetup ? (
          <ShieldPlus className="h-4 w-4" aria-hidden="true" />
        ) : (
          <LockOpen className="h-4 w-4" aria-hidden="true" />
        )}
        {buttonLabel}
      </Button>
    </div>
  )
}
