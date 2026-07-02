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

/**
 * Follow-up scheduling callback for the `schedule_follow_up` tool, bound to the
 * running persona/session/stream by the caller (like `ReactionToolDeps`). The
 * tool supplies only the note and target time; workspace/stream/persona/session
 * identity and the source-conversation anchor are fixed at bind time. Present
 * only on the live companion turn — the researcher sub-agent never schedules.
 */
export interface FollowUpToolDeps {
  scheduleFollowUp: (params: { note: string; scheduledFor: Date }) => Promise<ScheduleFollowUpToolResult>
}
