import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { StreamTypes, type E2eActorKind, type WorkspaceBootstrap } from "@threa/types"
import { e2eActorsApi } from "@/api/e2e-actors"
import { db } from "@/db"
import { streamKeys } from "./use-streams"
import { workspaceKeys } from "./use-workspaces"
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

export function useInviteActor(workspaceId: string, streamId: string) {
  const queryClient = useQueryClient()
  const [isInviting, setIsInviting] = useState(false)

  const invite = useCallback(
    async (kind: E2eActorKind) => {
      setIsInviting(true)
      try {
        const stream = await e2eActorsApi.invite(workspaceId, streamId, kind)

        // Reactive source of truth for the open stream is the IDB row
        // (useWorkspaceStreams → useLiveQuery), so update it surgically.
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

        toast.success(`${E2E_ACTOR_LABELS[kind]} invited to this scratchpad`)
      } catch (err) {
        const message = err instanceof Error ? err.message : `Failed to invite ${E2E_ACTOR_LABELS[kind]}`
        toast.error(message)
        throw err
      } finally {
        setIsInviting(false)
      }
    },
    [workspaceId, streamId, queryClient]
  )

  return { invite, isInviting }
}
