import type { Querier } from "../../db"
import type { SharedTree } from "../stream-connections"
import { ConversationRepository, type Conversation, type SharedConversation } from "./repository"

type PartnerReadableText = Pick<Conversation, "topicSummary" | "topicSummarySource" | "summary">

const WITHHELD: PartnerReadableText = { topicSummary: null, topicSummarySource: null, summary: null }

/**
 * A conversation's title and summary as the partner of the share rooted at
 * `rootStreamId` reads them: each only when it was written while shared.
 * `text` and `stamps` must come from the same row read, or a rename landing
 * between two reads would mark pre-share text as shared.
 */
export function readableByPartner(
  text: PartnerReadableText,
  stamps: Pick<SharedConversation, "topicSummarySharedRootStreamId" | "summarySharedRootStreamId">,
  rootStreamId: string
): PartnerReadableText {
  const titled = stamps.topicSummarySharedRootStreamId === rootStreamId
  return {
    topicSummary: titled ? text.topicSummary : null,
    topicSummarySource: titled ? (text.topicSummarySource ?? null) : null,
    summary: stamps.summarySharedRootStreamId === rootStreamId ? text.summary : null,
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
      ...(row ? readableByPartner(row.conversation, row, sharedTree.rootStreamId) : WITHHELD),
    }
  })
}
