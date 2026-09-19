import { useCallback, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { StreamTypes, type E2eActorKind, type Stream, type WorkspaceBootstrap } from "@threahq/types"
import { e2eActorsApi } from "@/api/e2e-actors"
import { rekeyStream } from "@/lib/crypto/stream-key-cache"
import { useE2eSession } from "@/stores/e2e-session-store"
import { db } from "@/db"
import { streamKeys } from "./use-streams"
import { workspaceKeys, useWorkspaceUserId } from "./use-workspaces"
import type { VirtualStream } from "./use-stream-or-draft"

/** Display label per actor kind — the single source of truth for actor naming in the UI. */
export const E2E_ACTOR_LABELS: Record<E2eActorKind, string> = {
  enclave: "Ariadne",
  bot: "Agent",
}

type ActorGate = Pick<VirtualStream, "type" | "isDraft" | "e2eEnabled" | "e2eActors">

/** An actor can be invited into a server-side E2E scratchpad that hasn't already invited that kind. */
export function canInviteActor(stream: ActorGate | undefined | null, kind: E2eActorKind): boolean {
  if (!stream) return false
  return (
    stream.type === StreamTypes.SCRATCHPAD &&
    !stream.isDraft &&
    stream.e2eEnabled === true &&
    !isActorInvited(stream, kind)
  )
}

export function isActorInvited(
  stream: Pick<VirtualStream, "e2eActors"> | undefined | null,
  kind: E2eActorKind
): boolean {
  return stream?.e2eActors?.some((a) => a.kind === kind) ?? false
}

/**
 * Land an actor change on the caches both the open stream and the sidebar read.
 * The reactive source of truth for the open stream is the IDB row
 * (`useWorkspaceStreams` → `useLiveQuery`), so update it surgically rather
 * than invalidating.
 */
async function applyActorChange(params: {
  workspaceId: string
  streamId: string
  stream: Stream
  queryClient: QueryClient
}): Promise<void> {
  const { workspaceId, streamId, stream, queryClient } = params

  await db.streams.update(streamId, { e2eActors: stream.e2eActors })

  queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
    if (!old || typeof old !== "object") return old
    return { ...old, stream }
  })

  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
    if (!old) return old
    return {
      ...old,
      streams: old.streams.map((s) =>
        s.id === streamId ? { ...s, ...stream, lastMessagePreview: s.lastMessagePreview } : s
      ),
    }
  })
}

/**
 * Invite an actor into a server-side E2E scratchpad and wrap the rolled SSK to
 * the new recipient set. Shared by the manual invite affordance
 * (`useInviteActor`) and the create-with-Ariadne path, so both go through one
 * code path (no drift). Returns `"wrapped"` when the SSK was rolled + wrapped,
 * or `"invited-unwrapped"` when the actor was recorded but no owner credentials
 * were available to wrap (the re-key happens later via the repair affordance).
 */
export async function inviteActorToStream(params: {
  workspaceId: string
  streamId: string
  kind: E2eActorKind
  actorId?: string
  queryClient: QueryClient
  /** Unlocked owner credentials for the SSK rewrap; null skips the wrap. */
  owner: { keyId: string; publicKey: Uint8Array } | null
}): Promise<"wrapped" | "invited-unwrapped"> {
  const { workspaceId, streamId, kind, actorId, queryClient, owner } = params
  const { stream, keyRoll } = await e2eActorsApi.invite(workspaceId, streamId, kind, actorId)

  await applyActorChange({ workspaceId, streamId, stream, queryClient })

  // The actor is recorded; now roll the SSK forward and wrap it to the new
  // recipient set so the agent can actually decrypt. `keyRoll` is null when the
  // actor has no live key yet — nothing to wrap to, so the invite stands and a
  // re-key happens once a key exists.
  if (keyRoll) {
    if (!owner) return "invited-unwrapped"
    await rekeyStream({
      workspaceId,
      streamId,
      nextGeneration: keyRoll.nextGeneration,
      ownerKeyId: owner.keyId,
      ownerPublicKey: owner.publicKey,
      actorRecipients: keyRoll.recipients,
    })
  }

  return "wrapped"
}

export function useInviteActor(workspaceId: string, streamId: string) {
  const queryClient = useQueryClient()
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const [isInviting, setIsInviting] = useState(false)

  const invite = useCallback(
    async (kind: E2eActorKind, actorId?: string) => {
      setIsInviting(true)
      try {
        const owner =
          session.status === "unlocked" && session.keyId && session.publicKey
            ? { keyId: session.keyId, publicKey: session.publicKey }
            : null
        const result = await inviteActorToStream({ workspaceId, streamId, kind, actorId, queryClient, owner })
        // The plain "invited" path is silent — the member list updates in place.
        // `invited-unwrapped` is a degraded outcome the user must act on: the actor
        // has no access until this scratchpad is unlocked and its key is wrapped.
        if (result === "invited-unwrapped") {
          toast.warning(`${E2E_ACTOR_LABELS[kind]} invited — unlock this scratchpad's encryption to grant it access.`)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : `Failed to invite ${E2E_ACTOR_LABELS[kind]}`
        toast.error(message)
        throw err
      } finally {
        setIsInviting(false)
      }
    },
    [workspaceId, streamId, queryClient, session.status, session.keyId, session.publicKey]
  )

  // Wrapping the SSK to the new actor needs the owner's unlocked credentials.
  // Callers gate the invite affordance on this so the actor is never recorded
  // unwrapped (a member that lists with access but can't decrypt).
  return { invite, isInviting, isUnlocked: session.status === "unlocked" }
}

/**
 * Take an actor back off a server-side E2E scratchpad and roll the SSK to
 * whoever is left. Both halves matter: the backend drops the wraps the revoked
 * actor could open (closing the history it hadn't fetched yet), and this roll
 * closes the future. Returns `"revoked-unrolled"` when the actor row is gone
 * but no owner credentials were available to roll — the stream still seals
 * under a generation the revoked actor holds a wrap for, so the caller must say
 * so.
 */
export async function revokeActorFromStream(params: {
  workspaceId: string
  streamId: string
  kind: E2eActorKind
  actorId: string
  queryClient: QueryClient
  /** Unlocked owner credentials for the roll; null skips it. */
  owner: { keyId: string; publicKey: Uint8Array } | null
}): Promise<"rolled" | "revoked-unrolled"> {
  const { workspaceId, streamId, kind, actorId, queryClient, owner } = params
  const { stream, keyRoll } = await e2eActorsApi.revoke(workspaceId, streamId, kind, actorId)

  await applyActorChange({ workspaceId, streamId, stream, queryClient })

  // `keyRoll` is null when nobody is left holding a live key: the owner is the
  // only reader, and its own wraps are already the current generation.
  if (keyRoll) {
    if (!owner) return "revoked-unrolled"
    await rekeyStream({
      workspaceId,
      streamId,
      nextGeneration: keyRoll.nextGeneration,
      ownerKeyId: owner.keyId,
      ownerPublicKey: owner.publicKey,
      actorRecipients: keyRoll.recipients,
    })
  }

  return "rolled"
}

export function useRevokeActor(workspaceId: string, streamId: string) {
  const queryClient = useQueryClient()
  const userId = useWorkspaceUserId(workspaceId)
  const session = useE2eSession(workspaceId, userId ?? "")
  const [isRevoking, setIsRevoking] = useState(false)

  const revoke = useCallback(
    async (kind: E2eActorKind, actorId: string) => {
      setIsRevoking(true)
      try {
        const owner =
          session.status === "unlocked" && session.keyId && session.publicKey
            ? { keyId: session.keyId, publicKey: session.publicKey }
            : null
        const result = await revokeActorFromStream({ workspaceId, streamId, kind, actorId, queryClient, owner })
        // The member list updates in place, so the plain path stays silent
        // (INV-63). A revoke that couldn't roll is the degraded outcome: past
        // messages stay readable to the revoked actor until the owner unlocks.
        if (result === "revoked-unrolled") {
          toast.warning(
            `${E2E_ACTOR_LABELS[kind]} removed — unlock this scratchpad's encryption to re-key it for the rest.`
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : `Failed to remove ${E2E_ACTOR_LABELS[kind]}`
        toast.error(message)
        throw err
      } finally {
        setIsRevoking(false)
      }
    },
    [workspaceId, streamId, queryClient, session.status, session.keyId, session.publicKey]
  )

  return { revoke, isRevoking, isUnlocked: session.status === "unlocked" }
}
