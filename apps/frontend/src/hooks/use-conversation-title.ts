import { useCallback, useSyncExternalStore } from "react"
import type { Conversation } from "@threa/types"
import { useStreamFromStore } from "@/stores/stream-store"
import {
  getCachedStreamName,
  isStreamNamePending,
  streamNameCacheKey,
  subscribeStreamName,
} from "@/lib/crypto/stream-name-cache"
import { effectiveConversationTitle } from "@/lib/conversations/title"

interface ConversationTitleDetails {
  title: string | null
  isE2e: boolean
  pending: boolean
}

export function useConversationTitleDetails(
  workspaceId: string,
  conversation: Pick<Conversation, "streamId" | "topicSummary">
): ConversationTitleDetails {
  const stream = useStreamFromStore(conversation.streamId)
  const nameKey =
    stream?.e2eEnabled && stream.sealedNameCiphertext
      ? streamNameCacheKey(workspaceId, stream.id, stream.sealedNameCiphertext)
      : null
  const subscribe = useCallback(
    (listener: () => void) => (nameKey ? subscribeStreamName(nameKey, listener) : () => {}),
    [nameKey]
  )
  const readName = useCallback(() => (nameKey ? getCachedStreamName(nameKey) : null), [nameKey])
  const decryptedTitle = useSyncExternalStore(subscribe, readName, readName)

  return {
    title: effectiveConversationTitle(conversation, stream, decryptedTitle),
    isE2e: stream?.e2eEnabled === true,
    pending: nameKey ? isStreamNamePending(nameKey) : false,
  }
}

export function useConversationTitle(
  workspaceId: string,
  conversation: Pick<Conversation, "streamId" | "topicSummary">
): string | null {
  return useConversationTitleDetails(workspaceId, conversation).title
}
