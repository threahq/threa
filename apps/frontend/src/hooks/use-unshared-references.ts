import { useMemo } from "react"
import { toast } from "sonner"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { ShareFlavor, UnsharedReference, UnsharedReferencesResponse } from "@threahq/types"
import { messagesApi } from "@/api/messages"

export const unsharedReferenceKeys = {
  list: (workspaceId: string) => ["unsharedReferences", workspaceId] as const,
}

const NO_REFERENCES: UnsharedReference[] = []

/**
 * The current user's sent messages whose shares or quotes went out without a
 * grant (a scheduled send fired after the source's audience changed). Keyed by
 * carrying message id.
 */
export function useUnsharedReferences(workspaceId: string | undefined) {
  const { data } = useQuery({
    queryKey: unsharedReferenceKeys.list(workspaceId ?? ""),
    queryFn: () => messagesApi.listUnsharedReferences(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 5 * 60_000,
  })
  const references = data?.references ?? NO_REFERENCES
  return useMemo(() => {
    const byMessage = new Map<string, UnsharedReference[]>()
    for (const reference of references) {
      const list = byMessage.get(reference.messageId)
      if (list) list.push(reference)
      else byMessage.set(reference.messageId, [reference])
    }
    return byMessage
  }, [references])
}

/** The flavor of the unshared reference `sourceMessageId` inside `messageId`, if any. */
export function useUnsharedReference(
  workspaceId: string | undefined,
  messageId: string | null | undefined,
  sourceMessageId: string
): ShareFlavor | null {
  const byMessage = useUnsharedReferences(workspaceId)
  if (!messageId) return null
  return byMessage.get(messageId)?.find((r) => r.sourceMessageId === sourceMessageId)?.flavor ?? null
}

/** The flavor a message's whole prompt takes: pointer when any unshared reference is a share, else quote. */
export function useUnsharedMessageFlavor(
  workspaceId: string | undefined,
  messageId: string | null | undefined
): ShareFlavor | null {
  const references = useUnsharedReferences(workspaceId).get(messageId ?? "")
  if (!messageId || !references) return null
  return references.some((r) => r.flavor === "pointer") ? "pointer" : "quote"
}

/** Refetch the list only when a cached row matches, so unrelated stream events cost nothing. */
export function refreshUnsharedReferencesIf(
  queryClient: QueryClient,
  workspaceId: string,
  matches: (reference: UnsharedReference) => boolean
) {
  const queryKey = unsharedReferenceKeys.list(workspaceId)
  const cached = queryClient.getQueryData<UnsharedReferencesResponse>(queryKey)
  if (cached?.references.some(matches)) void queryClient.invalidateQueries({ queryKey })
}

export function useShareReferences(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (messageId: string) => messagesApi.shareReferences(workspaceId, messageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: unsharedReferenceKeys.list(workspaceId) }),
    onError: () => toast.error("Couldn't share"),
  })
}
