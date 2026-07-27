export const CONTEXT_CATEGORIES = ["link", "media", "file", "memo", "delegation", "thread"] as const
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number]

/**
 * Categories a message body owns, i.e. exactly what `contextRowsForMessage`
 * rebuilds. An edit refresh must not touch the other categories — memo and
 * thread landmarks are anchored on a message but written by other paths and
 * nothing re-creates them.
 */
export const MESSAGE_BODY_CONTEXT_CATEGORIES = ["link", "media", "file"] as const

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
