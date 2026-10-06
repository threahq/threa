import type { Querier } from "../../db"
import type { SharedTree } from "../stream-connections"
import { ConversationRepository, type Conversation } from "./repository"

/**
 * The conversations as the shared channel's partner reads them: a title or
 * summary written before the share is withheld, so an AI writing for the
 * partner cannot carry it across. Unshared, they come back as they are.
 */
export async function viewConversationsAsPartner(
  db: Querier,
  workspaceId: string,
  sharedTree: SharedTree | null,
  conversations: Conversation[]
): Promise<Conversation[]> {
  if (!sharedTree || conversations.length === 0) return conversations
  const stamps = await ConversationRepository.findSharedStamps(
    db,
    workspaceId,
    conversations.map((conversation) => conversation.id)
  )
  return conversations.map((conversation) => {
    const stamp = stamps.get(conversation.id)
    return {
      ...conversation,
      topicSummary: stamp?.topicSummarySharedRootStreamId === sharedTree.rootStreamId ? conversation.topicSummary : null,
      summary: stamp?.summarySharedRootStreamId === sharedTree.rootStreamId ? conversation.summary : null,
    }
  })
}
