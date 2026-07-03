import type { Pool } from "pg"
import type { AttachmentService } from "../../attachments"
import type { MemoExplorerService } from "../../memos"
import type { SearchService } from "../../search"
import type { StorageProvider } from "../../../lib/storage/s3-client"

export interface WorkspaceToolDeps {
  db: Pool
  workspaceId: string
  accessibleStreamIds: string[]
  invokingUserId: string
  searchService: SearchService
  storage: StorageProvider
  attachmentService: AttachmentService
  memoExplorer: MemoExplorerService
}

/**
 * Reaction callbacks for the `react_to_message` tool. Separate from
 * `WorkspaceToolDeps` because only this one tool needs them — the persona
 * identity and `actorType: "persona"` are bound by the caller, so the tool only
 * supplies the target message, its stream, and the emoji shortcode. Each
 * resolves to the updated message, or `null` when the message no longer exists.
 */
export interface ReactionToolDeps {
  addReaction: (params: { streamId: string; messageId: string; emoji: string }) => Promise<{ id: string } | null>
  removeReaction: (params: { streamId: string; messageId: string; emoji: string }) => Promise<{ id: string } | null>
}

/**
 * Result the `schedule_follow_up` tool reports back to the model. On success it
 * carries the resolved cap + current pending count so the model can self-regulate
 * (don't pile up follow-ups); `cap_reached` tells it to schedule fewer.
 */
export type ScheduleFollowUpToolResult =
  | { ok: true; followUpId: string; scheduledFor: Date; pendingCount: number; limit: number }
  | { ok: false; reason: "cap_reached"; pendingCount: number; limit: number }

/** One pending follow-up as the `list_follow_ups` tool reports it. */
export interface FollowUpSummary {
  followUpId: string
  note: string
  scheduledFor: Date
}

/**
 * Result of the `cancel_follow_up` tool's callback. `null` from the service (row
 * gone, in another stream, or no longer pending) collapses to `ok: false` — the
 * tool tells the model to re-list rather than guessing why.
 */
export type CancelFollowUpToolResult = { ok: true; followUpId: string } | { ok: false }

/**
 * Result of the `update_follow_up` tool's callback. `not_found` = bad id or a
 * follow-up in another stream; `not_pending` = already fired or cancelled (can't
 * be edited). On success it echoes the stored note + new time.
 */
export type UpdateFollowUpToolResult =
  | { ok: true; followUpId: string; note: string; scheduledFor: Date }
  | { ok: false; reason: "not_found" | "not_pending" }

/**
 * Per-tool callbacks for the follow-up tools, each bound to the running
 * persona/session/stream by the caller (like `ReactionToolDeps`). The tools
 * supply only their own inputs (note/time/id); workspace/stream/persona/session
 * identity — and, for scheduling, the source-conversation anchor — are fixed at
 * bind time. The admin tools (list/cancel/update) are stream-scoped by the bind,
 * so a turn can only administer its own stream's follow-ups.
 *
 * Each tool takes only the narrow interface it needs so its unit test can wire a
 * single callback; `FollowUpToolDeps` is the bundle the live companion turn
 * passes (the researcher sub-agent never gets it — it reads/searches, it never
 * schedules or administers durable work).
 */
export interface ScheduleFollowUpToolDeps {
  scheduleFollowUp: (params: { note: string; scheduledFor: Date }) => Promise<ScheduleFollowUpToolResult>
}
export interface ListFollowUpsToolDeps {
  listFollowUps: () => Promise<FollowUpSummary[]>
}
export interface CancelFollowUpToolDeps {
  cancelFollowUp: (params: { followUpId: string }) => Promise<CancelFollowUpToolResult>
}
export interface UpdateFollowUpToolDeps {
  updateFollowUp: (params: {
    followUpId: string
    note?: string
    scheduledFor?: Date
  }) => Promise<UpdateFollowUpToolResult>
}
export interface FollowUpToolDeps
  extends ScheduleFollowUpToolDeps, ListFollowUpsToolDeps, CancelFollowUpToolDeps, UpdateFollowUpToolDeps {}
