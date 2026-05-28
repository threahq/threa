import { Lock, LockOpen, ShieldPlus, Wrench } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { e2eKeyWrapsApi } from "@/api/e2e-key-wraps"
import { provisionOwnerStreamKey } from "@/lib/crypto/stream-key-cache"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useE2eSession } from "@/stores/e2e-session-store"
import { useE2eUnlockOptional, type E2eUnlockContextValue } from "./e2e-unlock-provider"

type EncryptionAction =
  | { kind: "setup"; unlock: E2eUnlockContextValue }
  | { kind: "unlock"; unlock: E2eUnlockContextValue; pending: boolean }

export const e2eKeyWrapKeys = {
  list: (workspaceId: string, streamId: string) => ["e2e-key-wraps", workspaceId, streamId] as const,
}

/**
 * Decides the setup/unlock call-to-action for a stream surface, or null when
 * none is warranted: the stream isn't encrypted, the provider is absent (unit
 * harnesses), the user isn't resolved yet, we're still hydrating (`unknown`),
 * or the session is unlocked (nothing to unlock).
 *
 * Deliberately provider-free — it touches no react-query — so the always-mounted
 * composer notice doesn't force a `QueryClientProvider` onto every composer test.
 * The repair probe (which does use react-query) lives in a child that only
 * mounts for encrypted streams. Both header and composer share this hook so
 * "how do I unlock?" has one answer per state instead of drifting per surface.
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
      // `unlocked` (handled by the repair probe) and `unknown` (loading) render nothing here.
      return null
  }
}

interface OwnerWrapRepair {
  repair: () => void
  pending: boolean
}

/**
 * Probes whether an unlocked owner's stream is missing its own SSK wrap — the
 * orphaned-create state where the stream was minted but the wrap store failed,
 * leaving an unwritable scratchpad (we don't tear the stream down on failure).
 * Returns a one-click re-provision when so, else null.
 *
 * Uses react-query, so it's only invoked from the repair child components that
 * mount exclusively for encrypted streams — which always live under the app's
 * `QueryClientProvider`. Re-provisioning is only offered when the wrap set is
 * empty: a non-empty set means ciphertext may already be sealed under an SSK we
 * must not replace.
 */
function useOwnerWrapRepair(workspaceId: string, streamId: string): OwnerWrapRepair | null {
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const queryClient = useQueryClient()

  const sessionReady = session.status === "unlocked" && !!session.keyId && !!session.publicKey

  const wrapsQuery = useQuery({
    queryKey: e2eKeyWrapKeys.list(workspaceId, streamId),
    queryFn: () => e2eKeyWrapsApi.get(workspaceId, streamId),
    enabled: sessionReady,
    staleTime: 60_000,
  })

  const repairMutation = useMutation({
    mutationFn: async () => {
      if (!session.keyId || !session.publicKey) throw new Error("Encryption session not ready")
      await provisionOwnerStreamKey({
        workspaceId,
        streamId,
        ownerKeyId: session.keyId,
        ownerPublicKey: session.publicKey,
      })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: e2eKeyWrapKeys.list(workspaceId, streamId) }),
  })

  if (!sessionReady) return null
  if (repairMutation.isPending || wrapsQuery.data?.wraps.length === 0) {
    return { repair: () => repairMutation.mutate(), pending: repairMutation.isPending }
  }
  return null
}

/**
 * Inline unlock affordance for the stream header — sits beside the "Encrypted"
 * pill so a locked stream can be unlocked in place, without detouring through
 * Settings. Renders nothing for unencrypted or already-unlocked streams; an
 * unlocked stream missing its owner wrap gets a repair button via the child.
 */
export function StreamHeaderEncryptionAction({
  workspaceId,
  encrypted,
  streamId,
}: {
  workspaceId: string
  encrypted: boolean
  streamId?: string
}) {
  const action = useStreamEncryptionAction(workspaceId, encrypted)

  if (action?.kind === "setup") {
    return (
      <Button size="sm" variant="outline" className="h-7 gap-1 px-2" onClick={() => action.unlock.openSetup()}>
        <ShieldPlus className="h-3.5 w-3.5" />
        Set up encryption
      </Button>
    )
  }
  if (action?.kind === "unlock") {
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
  if (encrypted && streamId) {
    return <StreamHeaderRepairAction workspaceId={workspaceId} streamId={streamId} />
  }
  return null
}

function StreamHeaderRepairAction({ workspaceId, streamId }: { workspaceId: string; streamId: string }) {
  const repair = useOwnerWrapRepair(workspaceId, streamId)
  if (!repair) return null
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1 px-2"
      disabled={repair.pending}
      onClick={() => repair.repair()}
    >
      <Wrench className="h-3.5 w-3.5" />
      {repair.pending ? "Finishing…" : "Finish setup"}
    </Button>
  )
}

/**
 * Composer banner shown above the message input when an encrypted stream is
 * locked (or not yet set up). Encrypting a message needs the in-memory key, so
 * this gives the user a one-click way to unlock right where they're about to
 * type. Renders nothing once unlocked or for unencrypted streams — except when
 * an unlocked stream is missing its owner wrap, where the child offers a repair.
 */
export function ComposerEncryptionNotice({
  workspaceId,
  encrypted,
  streamId,
  className,
}: {
  workspaceId: string
  encrypted: boolean
  streamId?: string
  className?: string
}) {
  const action = useStreamEncryptionAction(workspaceId, encrypted)

  if (!action) {
    if (encrypted && streamId) {
      return <ComposerRepairNotice workspaceId={workspaceId} streamId={streamId} className={className} />
    }
    return null
  }

  const isSetup = action.kind === "setup"
  return (
    <EncryptionNoticeShell
      className={className}
      message={
        isSetup
          ? "Set up encryption to write in this scratchpad."
          : "This scratchpad is encrypted. Unlock it to read and write messages."
      }
      action={
        isSetup ? (
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
        )
      }
    />
  )
}

function ComposerRepairNotice({
  workspaceId,
  streamId,
  className,
}: {
  workspaceId: string
  streamId: string
  className?: string
}) {
  const repair = useOwnerWrapRepair(workspaceId, streamId)
  if (!repair) return null
  return (
    <EncryptionNoticeShell
      className={className}
      message="This scratchpad's encryption wasn't finished. Finish setup to write messages."
      action={
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 px-2"
          disabled={repair.pending}
          onClick={() => repair.repair()}
        >
          <Wrench className="h-3.5 w-3.5" />
          {repair.pending ? "Finishing…" : "Finish setup"}
        </Button>
      }
    />
  )
}

function EncryptionNoticeShell({
  message,
  action,
  className,
}: {
  message: string
  action: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "mb-2 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs",
        className
      )}
    >
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Lock className="h-3.5 w-3.5 shrink-0" />
        {message}
      </span>
      {action}
    </div>
  )
}
