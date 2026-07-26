export const CONTEXT_CATEGORIES = ["link", "media", "file", "memo", "delegation", "thread"] as const
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number]

export const CONTEXT_REF_KINDS = ["url", "attachment", "giphy", "memo", "delegation", "thread"] as const
export type ContextRefKind = (typeof CONTEXT_REF_KINDS)[number]

export interface NewStreamContextItem {
  id: string
  workspaceId: string
  streamId: string
  rootStreamId: string
  category: ContextCategory
  refKind: ContextRefKind
  refId: string
  groupKey: string
  sourceMessageId: string | null
  authorId: string | null
  occurredAt: Date
  sequence: bigint | null
  snippet: string
  detail: Record<string, unknown>
}
