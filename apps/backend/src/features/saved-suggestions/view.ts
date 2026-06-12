import type { SavedSuggestionView } from "@threa/types"
import type { SavedSuggestion } from "./repository"

/** Map a persisted suggestion to its wire shape (ISO timestamps). */
export function toSuggestionView(row: SavedSuggestion): SavedSuggestionView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    streamId: row.streamId,
    conversationId: row.conversationId,
    title: row.title,
    context: row.context,
    sourceMessageIds: row.sourceMessageIds,
    dueAt: row.dueAt?.toISOString() ?? null,
    status: row.status,
    savedMessageId: row.savedMessageId,
    createdAt: row.createdAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
  }
}
