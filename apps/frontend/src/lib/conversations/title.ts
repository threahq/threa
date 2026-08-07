import { StreamTypes, type Conversation, type Stream } from "@threa/types"
import { stripMarkdownToInline } from "@/lib/markdown/strip"

type ConversationTitle = Pick<Conversation, "streamId" | "topicSummary">
type TitleStream = Pick<Stream, "id" | "type" | "displayName">

export function effectiveConversationTitle(
  conversation: ConversationTitle,
  stream: TitleStream | null | undefined
): string | null {
  const title =
    stream?.type === StreamTypes.SCRATCHPAD && stream.id === conversation.streamId
      ? stream.displayName
      : conversation.topicSummary
  return title ? stripMarkdownToInline(title) : null
}
