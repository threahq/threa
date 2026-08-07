import type { Conversation } from "@threa/types"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { effectiveConversationTitle } from "@/lib/conversations/title"

export function useConversationTitle(
  workspaceId: string,
  conversation: Pick<Conversation, "streamId" | "topicSummary">
): string | null {
  const streams = useWorkspaceStreams(workspaceId)
  return effectiveConversationTitle(
    conversation,
    streams.find((stream) => stream.id === conversation.streamId)
  )
}
