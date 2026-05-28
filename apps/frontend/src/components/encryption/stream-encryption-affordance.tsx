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
  | { kind: "repair"; repair: () => void; pending: boolean }

export const e2eKeyWrapKeys = {
  list: (workspaceId: string, streamId: string) => ["e2e-key-wraps", workspaceId, streamId] as const,
}

/**
 * Decides the encryption call-to-action for a stream surface, or null when
 * none is warranted: the stream isn't encrypted, the provider is absent
 * (unit harnesses), the user isn't resolved yet, or we're still hydrating
 * (`unknown`) and shouldn't flash a CTA.
 *
 * One state needs the stream id: an unlocked session whose stream has *no*
 * owner wrap. That happens when create minted the stream but the wrap store
 * failed (we don't tear the stream down on failure), leaving an unwritable
 * scratchpad. With the id we detect the empty wrap set and offer a one-click
 * repair that re-runs provisioning. Without an id (e.g. unit harnesses) the
 * unlocked state simply renders nothing, as before.
 *
 * Both the header button and the composer notice share this so "what do I do
 * here?" has one answer per state instead of drifting per surface.
 */
function useStreamEncryptionAction(
  workspaceId: string,
  encrypted: boolean,
  streamId?: string
): EncryptionAction | null {
  const unlock = useE2eUnlockOptional()
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const queryClient = useQueryClient()

  const sessionReady = session.status === "unlocked" && !!session.keyId && !!session.publicKey
  const canDetectRepair = Boolean(encrypted && unlock && userId && streamId && sessionReady)

  // Only an unlocked session can tell whether its own wrap is missing, so the
  // probe is gated on `canDetectRepair`. A normal stream returns a non-empty
  // wrap set and this resolves to "no action".
  const wrapsQuery = useQuery({
    queryKey: e2eKeyWrapKeys.list(workspaceId, streamId ?? ""),
    queryFn: () => e2eKeyWrapsApi.get(workspaceId, streamId ?? ""),
    enabled: canDetectRepair,
    staleTime: 60_000,
  })

  const repairMutation = useMutation({
    mutationFn: async () => {
      if (!streamId || !session.keyId || !session.publicKey) {
        throw new Error("Encryption session not ready")
      }
      await provisionOwnerStreamKey({
        workspaceId,
        streamId,
        ownerKeyId: session.keyId,
        ownerPublicKey: session.publicKey,
      })
    },
    onSuccess: () => {
      if (streamId) void queryClient.invalidateQueries({ queryKey: e2eKeyWrapKeys.list(workspaceId, streamId) })
    },
  })

  if (!encrypted || !unlock || !userId) return null
  switch (session.status) {
    case "no-key":
      return { kind: "setup", unlock }
    case "locked":
    case "unlocking":
      return { kind: "unlock", unlock, pending: session.status === "unlocking" }
    case "unlocked": {
      // A wrap set that came back empty means create never finished — offer the
      // repair. Re-running provisioning is only safe with zero existing wraps
      // (no ciphertext sealed under an SSK we'd be replacing).
      if (repairMutation.isPending || wrapsQuery.data?.wraps.length === 0) {
        return { kind: "repair", repair: () => repairMutation.mutate(), pending: repairMutation.isPending }
      }
      return null
    }
    default:
      // `unknown` (still loading) renders nothing.
      return null
  }
}

/**
 * Inline unlock affordance for the stream header — sits beside the "Encrypted"
 * pill so a locked stream can be unlocked in place, without detouring through
 * Settings. Renders nothing for unencrypted or already-unlocked streams.
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
  const action = useStreamEncryptionAction(workspaceId, encrypted, streamId)
  if (!action) return null

  if (action.kind === "setup") {
    return (
      <Button size="sm" variant="outline" className="h-7 gap-1 px-2" onClick={() => action.unlock.openSetup()}>
        <ShieldPlus className="h-3.5 w-3.5" />
        Set up encryption
      </Button>
    )
  }

  if (action.kind === "repair") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2"
        disabled={action.pending}
        onClick={() => action.repair()}
      >
        <Wrench className="h-3.5 w-3.5" />
        {action.pending ? "Finishing…" : "Finish setup"}
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
  streamId,
  className,
}: {
  workspaceId: string
  encrypted: boolean
  streamId?: string
  className?: string
}) {
  const action = useStreamEncryptionAction(workspaceId, encrypted, streamId)
  if (!action) return null

  return (
    <div
      className={cn(
        "mb-2 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs",
        className
      )}
    >
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Lock className="h-3.5 w-3.5 shrink-0" />
        {noticeMessage(action.kind)}
      </span>
      <ComposerEncryptionButton action={action} />
    </div>
  )
}

function noticeMessage(kind: EncryptionAction["kind"]): string {
  switch (kind) {
    case "setup":
      return "Set up encryption to write in this scratchpad."
    case "repair":
      return "This scratchpad's encryption wasn't finished. Finish setup to write messages."
    default:
      return "This scratchpad is encrypted. Unlock it to read and write messages."
  }
}

function ComposerEncryptionButton({ action }: { action: EncryptionAction }) {
  if (action.kind === "setup") {
    return (
      <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2" onClick={() => action.unlock.openSetup()}>
        <ShieldPlus className="h-3.5 w-3.5" />
        Set up
      </Button>
    )
  }

  if (action.kind === "repair") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 gap-1 px-2"
        disabled={action.pending}
        onClick={() => action.repair()}
      >
        <Wrench className="h-3.5 w-3.5" />
        {action.pending ? "Finishing…" : "Finish setup"}
      </Button>
    )
  }

  return (
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
