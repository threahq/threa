import { StreamTypes, type Conversation, type Stream } from "@threahq/types"
import { stripMarkdownToInline } from "@/lib/markdown/strip"
import { isDecryptedStreamNameOverlay } from "@/lib/crypto/stream-name-cache"

type ConversationTitle = Pick<Conversation, "streamId" | "topicSummary">
type TitleStream = Pick<Stream, "id" | "type" | "displayName"> & Partial<Pick<Stream, "e2eEnabled">>

export function effectiveConversationTitle(
  conversation: ConversationTitle,
  stream: TitleStream | null | undefined,
  decryptedStreamTitle?: string | null
): string | null {
  const isRootScratchpad = stream?.type === StreamTypes.SCRATCHPAD && stream.id === conversation.streamId
  let title = conversation.topicSummary
  if (isRootScratchpad) {
    const memoryOnlyTitle = decryptedStreamTitle ?? (isDecryptedStreamNameOverlay(stream) ? stream.displayName : null)
    title = stream.e2eEnabled ? memoryOnlyTitle : stream.displayName
  }
  return title ? stripMarkdownToInline(title) : null
}
