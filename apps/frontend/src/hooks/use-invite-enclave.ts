import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { E2eInvitedAgentKinds, StreamTypes, type WorkspaceBootstrap } from "@threa/types"
import { enclaveApi } from "@/api/enclave"
import { db } from "@/db"
import { streamKeys } from "./use-streams"
import { workspaceKeys } from "./use-workspaces"
import type { VirtualStream } from "./use-stream-or-draft"

type EnclaveGate = Pick<VirtualStream, "type" | "isDraft" | "e2eEnabled" | "e2eInvitedAgentKind">

/** The enclave can be invited into a server-side E2E scratchpad that hasn't already invited an agent. */
export function canInviteEnclave(stream: EnclaveGate | undefined | null): boolean {
  if (!stream) return false
  return (
    stream.type === StreamTypes.SCRATCHPAD &&
    !stream.isDraft &&
    stream.e2eEnabled === true &&
    stream.e2eInvitedAgentKind !== E2eInvitedAgentKinds.ENCLAVE
  )
}

export function isEnclaveInvited(stream: Pick<VirtualStream, "e2eInvitedAgentKind"> | undefined | null): boolean {
  return stream?.e2eInvitedAgentKind === E2eInvitedAgentKinds.ENCLAVE
}

export function useInviteEnclave(workspaceId: string, streamId: string) {
  const queryClient = useQueryClient()
  const [isInviting, setIsInviting] = useState(false)

  const invite = useCallback(async () => {
    setIsInviting(true)
    try {
      const stream = await enclaveApi.invite(workspaceId, streamId)

      // Reactive source of truth for the open stream is the IDB row
      // (useWorkspaceStreams → useLiveQuery), so update it surgically.
      await db.streams.update(streamId, { e2eInvitedAgentKind: stream.e2eInvitedAgentKind })

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

      toast.success("Ariadne invited to this scratchpad")
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to invite Ariadne"
      toast.error(message)
      throw err
    } finally {
      setIsInviting(false)
    }
  }, [workspaceId, streamId, queryClient])

  return { invite, isInviting }
}
