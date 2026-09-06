import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  TitleSources,
  type BoardPost,
  type ConversationWithStaleness,
  type Stream,
  type TitleSource,
} from "@threahq/types"
import { conversationsApi } from "@/api/conversations"
import { streamsApi } from "@/api/streams"
import { sealStreamRename } from "@/lib/crypto/stream-rename"
import {
  mergeConversationByTitleRevision,
  mergeStreamByTitleRevision,
  persistStreamByTitleRevision,
} from "@/lib/title-merge"
import { mergeBoardConversation } from "@/stores/board-store"
import { conversationKeys } from "./use-conversations"
import { streamKeys } from "./use-streams"
import { useWorkspaceUserId, workspaceKeys } from "./use-workspaces"

export function isProtectedRegenerableTitle(title: string | null, source: TitleSource | null | undefined): boolean {
  if (!title) return false
  const effectiveSource = source ?? TitleSources.LEGACY
  return effectiveSource === TitleSources.EXPLICIT || effectiveSource === TitleSources.LEGACY
}

type RegenerationTarget =
  | { kind: "stream"; stream: Pick<Stream, "id" | "e2eEnabled">; currentTitle: string }
  | { kind: "conversation"; conversationId: string; currentTitle: string; source?: TitleSource | null }

export function useRegenerateTitle(workspaceId: string, target: RegenerationTarget) {
  const queryClient = useQueryClient()
  const userId = useWorkspaceUserId(workspaceId) ?? ""
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const regenerate = useCallback(async () => {
    setIsPending(true)
    setError(null)
    try {
      if (target.kind === "stream") {
        const sealed = target.stream.e2eEnabled
          ? await sealStreamRename({
              workspaceId,
              streamId: target.stream.id,
              userId,
              name: target.currentTitle,
              refreshCurrentKey: true,
            })
          : undefined
        const result = await streamsApi.regenerateTitle(workspaceId, target.stream.id, sealed)
        await persistStreamByTitleRevision(result.stream)
        queryClient.setQueryData<Stream>(streamKeys.detail(workspaceId, target.stream.id), (old) =>
          old ? mergeStreamByTitleRevision(old, result.stream) : result.stream
        )
        queryClient.invalidateQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
        if (result.deferred) toast.info("Title will regenerate after Ariadne's next reply")
        return
      }
      const result = await conversationsApi.regenerateTitle(workspaceId, target.conversationId)
      await mergeBoardConversation(target.conversationId, result.conversation)
      queryClient.setQueryData<ConversationWithStaleness>(
        conversationKeys.byId(workspaceId, target.conversationId),
        (old) => (old ? mergeConversationByTitleRevision(old, result.conversation) : result.conversation)
      )
      queryClient.setQueryData<BoardPost>(conversationKeys.boardPost(target.conversationId), (old) =>
        old
          ? {
              ...old,
              conversation: mergeConversationByTitleRevision(old.conversation, result.conversation),
            }
          : old
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationKeys.workspaceLists(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: conversationKeys.byId(workspaceId, target.conversationId) }),
      ])
    } catch (cause) {
      const next = cause instanceof Error ? cause : new Error("Failed to regenerate title")
      setError(next)
      toast.error(next.message)
      throw next
    } finally {
      setIsPending(false)
    }
  }, [queryClient, target, userId, workspaceId])

  return { regenerate, isPending, error }
}
