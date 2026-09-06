import type { ScheduledMessageView } from "@threahq/types"
import type { ScheduledMessage } from "./repository"

/**
 * Wire shape for a scheduled-message row. `editActiveUntil` exposes the
 * worker fence so the frontend can render a "currently being edited"
 * affordance across devices.
 *
 * Unlike saved-messages we do NOT denormalize a live message snapshot —
 * `contentJson` and `contentMarkdown` are already canonical on the scheduled
 * row itself (it IS the draft). The frontend renders directly from these.
 */
export function toScheduledMessageView(row: ScheduledMessage): ScheduledMessageView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    streamId: row.streamId,
    parentMessageId: row.parentMessageId,
    contentJson: row.contentJson,
    contentMarkdown: row.contentMarkdown,
    attachmentIds: row.attachmentIds,
    metadata: row.metadata,
    scheduledFor: row.scheduledFor.toISOString(),
    status: row.status,
    sentMessageId: row.sentMessageId,
    lastError: row.lastError,
    editActiveUntil: row.editActiveUntil?.toISOString() ?? null,
    clientMessageId: row.clientMessageId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
  }
}
