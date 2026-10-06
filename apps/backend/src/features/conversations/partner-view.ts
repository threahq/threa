import type { TitleSource } from "@threahq/types"
import type { Querier } from "../../db"
import type { SharedTree } from "../stream-connections"
import { ConversationRepository, type Conversation, type SharedConversation } from "./repository"

interface PartnerReadableText {
  topicSummary: string | null
  topicSummarySource: TitleSource | null
  summary: string | null
}

const WITHHELD: PartnerReadableText = { topicSummary: null, topicSummarySource: null, summary: null }

/**
 * A conversation's title and summary as the partner of the share rooted at
 * `rootStreamId` reads them: each only when it was written while shared.
 */
export function readableByPartner(
  { conversation, topicSummarySharedRootStreamId, summarySharedRootStreamId }: SharedConversation,
  rootStreamId: string
): PartnerReadableText {
  const titled = topicSummarySharedRootStreamId === rootStreamId
  return {
    topicSummary: titled ? conversation.topicSummary : null,
    topicSummarySource: titled ? (conversation.topicSummarySource ?? null) : null,
    summary: summarySharedRootStreamId === rootStreamId ? conversation.summary : null,
  }
}

/**
 * The conversations as the shared channel's partner reads them, so an AI
 * writing for the partner cannot carry a pre-share title or summary across.
 * Unshared, they come back as they are.
 */
export async function viewConversationsAsPartner(
  db: Querier,
  workspaceId: string,
  sharedTree: SharedTree | null,
  conversations: Conversation[]
): Promise<Conversation[]> {
  if (!sharedTree || conversations.length === 0) return conversations
  const shared = new Map(
    (
      await ConversationRepository.findShared(
        db,
        workspaceId,
        [...sharedTree.streamIds],
        conversations.map((conversation) => conversation.id)
      )
    ).map((row) => [row.conversation.id, row])
  )
  return conversations.map((conversation) => {
    const row = shared.get(conversation.id)
    return {
      ...conversation,
      ...(row ? readableByPartner(row, sharedTree.rootStreamId) : WITHHELD),
    }
  })
}
