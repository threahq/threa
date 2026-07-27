import type { ContextCategory, StreamContextRefKind } from "@threa/types"

export { CONTEXT_CATEGORIES, MESSAGE_BODY_CONTEXT_CATEGORIES, STREAM_CONTEXT_REF_KINDS } from "@threa/types"
export type { ContextCategory, StreamContextRefKind } from "@threa/types"

export interface NewStreamContextItem {
  id: string
  workspaceId: string
  streamId: string
  rootStreamId: string
  category: ContextCategory
  refKind: StreamContextRefKind
  refId: string
  groupKey: string
  sourceMessageId: string | null
  authorId: string | null
  occurredAt: Date
  sequence: bigint | null
  snippet: string
  detail: Record<string, unknown>
}
