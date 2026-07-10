import type { Pool } from "pg"
import type { KnowledgeType } from "@threa/types"
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

/**
 * Result of the `update_stream_brief` tool's callback (roadmap 4.2). On success
 * it echoes the new `version`. `version_conflict` means a concurrent write (a
 * member editing in settings mid-turn) moved the brief past the version the turn
 * read at context time — the callback returns the fresh content + version so the
 * tool can hand them to the model to re-apply on top (retry-once).
 */
export type UpdateStreamBriefToolResult =
  | { ok: true; version: number }
  | { ok: false; reason: "version_conflict"; currentContent: string | null; currentVersion: number }

/**
 * Callback for the `update_stream_brief` tool, bound to the running
 * persona/stream by the caller (like `ReactionToolDeps`). The tool supplies the
 * replacement `content`, the model's `reason`, and the `expectedVersion` it is
 * writing against (seeded from the brief read at context time, advanced by the
 * tool after each write so a retry writes at the fresh version). Workspace,
 * effective-root stream, and persona identity are fixed at bind time. Absent
 * when briefs aren't wired (some test harnesses), which disables the tool.
 */
export interface UpdateStreamBriefToolDeps {
  updateBrief: (params: {
    content: string
    reason: string
    expectedVersion: number
  }) => Promise<UpdateStreamBriefToolResult>
}

/**
 * Result of the `delegate_task` tool's callback (roadmap 5.1). On success it
 * echoes the delegation id plus the refs that were dropped by the invoking
 * user's access check — the model sees exactly which pointers didn't make it
 * onto the card so it can mention or correct them.
 */
export type DelegateTaskToolResult =
  | { ok: true; delegationId: string; droppedRefs: Array<{ ref: string; reason: string }> }
  | { ok: false; error: string }

/**
 * Callback for the `delegate_task` tool, bound to the running persona/session/
 * stream — AND the invoking user — by the caller. The tool supplies only the
 * hand-off content ({ title, brief, contextRefs }); identity, the
 * source-conversation anchor, and the user's access reach are fixed at bind
 * time. The bundle is absent (tool disabled) on sealed streams — a server-built
 * plaintext brief cannot egress an E2E stream — and on turns without a human
 * trigger, since refs resolve against the invoking user's access.
 */
export interface DelegateTaskToolDeps {
  delegateTask: (params: { title: string; brief: string; contextRefs: string[] }) => Promise<DelegateTaskToolResult>
}

/**
 * Result of the `save_memo` tool's callback (roadmap 6.2). `deduped: true` means
 * an equivalent memo already existed in this stream, so `memoId` points at that
 * row and nothing new was written — the knowledge is retained either way. The
 * tool surfaces `deduped` so the model learns "already remembered" rather than
 * re-saving.
 */
export type SaveMemoToolResult = { ok: true; memoId: string; title: string; deduped: boolean } | { ok: false }

/**
 * Callback for the `save_memo` tool, bound to the running persona's
 * workspace/stream/session by the caller (like the follow-up/brief tools). The
 * tool supplies the memo content + its source message ids; the write goes
 * through `MemoService.saveMemo` (dedup + embedding + capture event). Absent when
 * memos aren't wired (some test harnesses), which disables the tool.
 */
export interface SaveMemoToolDeps {
  saveMemo: (params: {
    title: string
    abstract: string
    keyPoints: string[]
    tags: string[]
    knowledgeType: KnowledgeType
    sourceMessageIds: string[]
  }) => Promise<SaveMemoToolResult>
}
