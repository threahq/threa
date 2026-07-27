import type { ContextCategory, StreamContextRefKind } from "@threa/types"

/**
 * Categories a message body owns, i.e. exactly what `contextRowsForMessage`
 * rebuilds. An edit refresh must not touch the other categories — memo and
 * thread landmarks are anchored on a message but written by other paths and
 * nothing re-creates them.
 */
export const MESSAGE_BODY_CONTEXT_CATEGORIES = ["link", "media", "file"] as const

export { CONTEXT_CATEGORIES, STREAM_CONTEXT_REF_KINDS } from "@threa/types"
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
