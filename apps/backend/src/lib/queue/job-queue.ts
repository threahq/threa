import { AgentTriggers, type AgentSessionRerunContext, type JSONContent } from "@threa/types"
import type { DynamicNamingEvaluateJobData } from "./dynamic-naming-contract"
export type { DynamicNamingEvaluateJobData } from "./dynamic-naming-contract"

export interface Job<T = unknown> {
  id: string
  name: string
  data: T
  /**
   * Zero-based count of prior failed attempts (`failedCount`) for this message —
   * 0 on the first run. Set by the queue manager on dispatch. A handler that wants
   * to distinguish "will retry" from "last chance" combines this with
   * {@link maxAttempts}: the message goes to the DLQ when `attempt + 1 >= maxAttempts`.
   * Absent only on synthetic jobs constructed outside the dispatch loop (e.g. the
   * onDLQ hook), where the retry budget is already spent.
   */
  attempt?: number
  /** Retry budget for this queue (manager-wide default or per-queue override). */
  maxAttempts?: number
}

export const JobQueues = {
  PERSONA_AGENT: "persona.agent",
  DYNAMIC_NAMING_EVALUATE: "dynamic-naming.evaluate",
  EMBEDDING_GENERATE: "embedding.generate",
  BOUNDARY_EXTRACT: "boundary.extract",
  CONVERSATION_STALENESS_SWEEP: "conversation.staleness-sweep",
  ATTACHMENT_UPLOAD_SWEEP: "attachment.upload-sweep",
  MEMO_BATCH_CHECK: "memo.batch-check",
  MEMO_BATCH_PROCESS: "memo.batch-process",
  COMMAND_EXECUTE: "command.execute",
  IMAGE_CAPTION: "image.caption",
  IMAGE_THUMBNAIL: "image.thumbnail",
  PDF_PREPARE: "pdf.prepare",
  PDF_PROCESS_PAGE: "pdf.process_page",
  PDF_ASSEMBLE: "pdf.assemble",
  TEXT_PROCESS: "text.process",
  WORD_PROCESS: "word.process",
  EXCEL_PROCESS: "excel.process",
  ATTACHMENT_EMBED: "attachment.embed",
  CONVERSATION_EMBEDDING_GENERATE: "conversation-embedding.generate",
  AVATAR_PROCESS: "avatar.process",
  LINK_PREVIEW_EXTRACT: "link_preview.extract",
  VIDEO_TRANSCODE_SUBMIT: "video.transcode_submit",
  VIDEO_TRANSCODE_CHECK: "video.transcode_check",
  SAVED_REMINDER_FIRE: "saved.reminder_fire",
  SCHEDULED_MESSAGE_SEND: "scheduled_message.send",
  AGENT_FOLLOW_UP_FIRE: "agent.follow_up_fire",
  AGENT_EPISODE_SUMMARIZE: "agent.episode_summarize",
  AGENT_REFLECTIVE_CAPTURE: "agent.reflective_capture",
  CONTEXT_BAG_PRECOMPUTE: "context_bag.precompute",
  BACKFILL_PLAN: "backfill.plan",
  BACKFILL_CHUNK: "backfill.chunk",
  GITHUB_WEBHOOK_PROCESS: "github_webhook.process",
  GITHUB_PREVIEW_REFRESH: "github_preview.refresh",
  LINK_PREVIEW_VISIBLE_REFRESH: "link_preview.visible-refresh",
} as const

export type JobQueueName = (typeof JobQueues)[keyof typeof JobQueues]

/** Unified persona agent job - handles both companion mode and @mention invocations */
export interface PersonaAgentJobData {
  workspaceId: string
  streamId: string // Where message was sent
  messageId: string // Trigger message
  personaId: string
  triggeredBy: string
  trigger?: typeof AgentTriggers.MENTION // undefined = companion mode
  supersedesSessionId?: string
  rerunContext?: AgentSessionRerunContext
  /**
   * Set when this job was enqueued by a fired follow-up. `messageId` is synthetic
   * (no real trigger message); the persona agent loads this follow-up's row and
   * injects a "why you woke up" prompt section so the turn knows it IS the
   * scheduled check-in firing (roadmap 1.2).
   */
  followUpId?: string
  /**
   * Set when the trigger message landed in a persona editor's test-drive
   * scratchpad (roadmap 7.1). `resolveTurnPurpose` maps it to a `draft_test`
   * turn; the precheck loads this draft and runs its candidate config instead of
   * the saved override, so the admin talks to the persona they're editing.
   */
  personaDraftId?: string
  /**
   * Set when this job is the kickoff turn of a subagent run. `messageId` is
   * synthetic (no trigger message); `resolveTurnPurpose` maps this to a
   * `subagent_kickoff` turn, which injects the run's brief as its wake-up
   * context and runs on the run's pinned model.
   */
  subagentRunId?: string
}

/**
 * Agent follow-up fire job. Enqueued with `process_after = scheduled_for` when a
 * follow-up is created; the worker CASes the row `pending → fired` and, on
 * success, enqueues a PERSONA_AGENT job so the persona wakes up. A cancelled row
 * fails the CAS and the worker no-ops (queue delivery can't be revoked).
 */
export interface AgentFollowUpFireJobData {
  workspaceId: string
  followUpId: string
}

/**
 * Agent episode-summary job (roadmap 3.1). Enqueued after a companion session
 * completes (persona-agent-worker), it condenses the finished session into a
 * ~2-3 sentence `episode_summary` on the `agent_sessions` row via a cheap model.
 * Deferred to a job — never inline — so the completion transaction stays short
 * and holds no connection across the summarizer AI call (INV-41). Idempotent:
 * re-delivery no-ops once the row already carries a summary.
 */
export interface AgentEpisodeSummarizeJobData {
  workspaceId: string
  sessionId: string
}

/**
 * Agent reflective-capture job (roadmap 6.3). Enqueued after a companion session
 * completes (persona-agent-worker), alongside the episode-summary job, it distils
 * a research-heavy session's tool-work digest + reply into ≤2 agent-authored
 * memos so research work products don't evaporate with the turn. Deferred to a
 * job — never inline — so the completion transaction holds no connection across
 * the classifier/memorizer AI calls (INV-41). Idempotent: a `reflective_captured_at`
 * CAS means re-delivery no-ops.
 */
export interface AgentReflectiveCaptureJobData {
  workspaceId: string
  sessionId: string
}

export interface EmbeddingJobData {
  messageId: string
  workspaceId: string
}

export interface BoundaryExtractionJobData {
  messageId: string
  streamId: string
  workspaceId: string
}

export interface ConversationStalenessSweepJobData {
  workspaceId: string // Use "system" for system-wide cron job
}

export interface AttachmentUploadSweepJobData {
  workspaceId: string // Use "system" for system-wide cron job
}

export interface MemoBatchCheckJobData {
  workspaceId: string // Use "system" for system-wide cron job
}

export interface MemoBatchProcessJobData {
  workspaceId: string
  streamId: string
}

export interface CommandExecuteJobData {
  commandId: string
  commandName: string
  args: string
  workspaceId: string
  streamId: string
  userId: string
}

export interface ImageCaptionJobData {
  attachmentId: string
  workspaceId: string
  filename: string
  mimeType: string
  storagePath: string
}

/** Image thumbnail job - resizes an uploaded image into a small WebP variant */
export interface ImageThumbnailJobData {
  attachmentId: string
  workspaceId: string
  filename: string
  mimeType: string
  storagePath: string
}

/** PDF prepare job - extracts text/images, classifies pages, fans out page jobs */
export interface PdfPrepareJobData {
  attachmentId: string
  workspaceId: string
  filename: string
  storagePath: string
}

/** PDF page processing job - processes single page based on classification */
export interface PdfProcessPageJobData {
  attachmentId: string
  workspaceId: string
  pageNumber: number
  pdfJobId: string
}

/** PDF assemble job - combines page results into document extraction */
export interface PdfAssembleJobData {
  attachmentId: string
  workspaceId: string
  pdfJobId: string
}

/** Text processing job - processes text-based attachments */
export interface TextProcessJobData {
  attachmentId: string
  workspaceId: string
  filename: string
  storagePath: string
}

/** Word processing job - processes Word documents (.doc, .docx) */
export interface WordProcessJobData {
  attachmentId: string
  workspaceId: string
  filename: string
  storagePath: string
}

/** Excel processing job - processes Excel workbooks (.xlsx, .xls, .xlsm) */
export interface ExcelProcessJobData {
  attachmentId: string
  workspaceId: string
  filename: string
  storagePath: string
}

/**
 * Attachment summary embedding job — generates a vector embedding for an
 * extraction's `summary` so attachments become semantically searchable.
 *
 * Enqueued by `AttachmentEmbeddingHandler` once an
 * `attachment:extraction_completed` outbox event lands. The worker fetches
 * the latest extraction state, applies the eligibility check (skips
 * `photo`/`other` content types), and updates `summary_embedding` in place.
 * Idempotent: a re-run for the same attachment overwrites the column.
 */
export interface AttachmentEmbeddingJobData {
  attachmentId: string
  workspaceId: string
}

/**
 * Embed a conversation's topic summary, summary and opening message so it can
 * be found as a search unit of its own. Idempotent: the worker skips when the
 * embedded text's hash is unchanged.
 */
export interface ConversationEmbeddingJobData {
  conversationId: string
  workspaceId: string
}

/** Avatar processing job - resizes raw upload into WebP variants */
export interface AvatarProcessJobData {
  workspaceId: string
  avatarUploadId: string
}

/** Link preview extraction job - fetches metadata for URLs in a message */
export interface LinkPreviewExtractJobData {
  workspaceId: string
  streamId: string
  messageId: string
  contentMarkdown: string
  /** Optional for compatibility with jobs queued before document-based extraction. */
  contentJson?: JSONContent | null
  /** When true, clears existing previews before re-extracting (message edit flow) */
  isEdit?: boolean
}

/** Video transcode submit job - submits video to AWS MediaConvert */
export interface VideoTranscodeSubmitJobData {
  attachmentId: string
  workspaceId: string
  filename: string
  storagePath: string
}

/** Video transcode check job - polls MediaConvert for completion */
export interface VideoTranscodeCheckJobData {
  attachmentId: string
  workspaceId: string
}

/**
 * Saved-message reminder fire job. Enqueued when a saved row gets a remindAt;
 * the worker looks up the row, emits `saved_reminder:fired` outbox event, and
 * updates `reminder_sent_at` idempotently. The job is a no-op if the row has
 * already been marked done/archived or the reminder was already delivered.
 */
export interface SavedReminderFireJobData {
  workspaceId: string
  userId: string
  savedMessageId: string
}

/**
 * Scheduled-message send job. Enqueued when a row is created or rescheduled
 * and tombstoned (queue cancel) when the row is cancelled or rescheduled.
 *
 * The worker re-reads the row scoped to (workspaceId, scheduledMessageId),
 * attempts a CAS to take the lock + flip status to `sending`, then invokes
 * EventService.createMessage with the stored payload. If the CAS fails (an
 * editor holds the lock), the worker schedules a short retry; bounded retry
 * count is enforced before marking the row `failed`.
 */
export interface ScheduledMessageSendJobData {
  workspaceId: string
  userId: string
  scheduledMessageId: string
}

/**
 * Context-bag pre-compute job. Warms the shared `context_summaries` cache and
 * persists the initial render snapshot for a newly-created bag-attached
 * scratchpad — see `context-bag-precompute-handler.ts` for the flow. No
 * kickoff message is posted; the first real turn happens when the user sends.
 */
export interface ContextBagPrecomputeJobData {
  workspaceId: string
  streamId: string
  bagId: string
}

/**
 * Generic backfill plan job. One per (backfill, workspace): the plan worker
 * runs the named backfill's `plan` to compute chunk descriptors, records a
 * `backfill_runs` row, and fans out one `backfill.chunk` job per descriptor.
 * `params` is opaque definition-specific input forwarded to `plan`.
 */
export interface BackfillPlanJobData {
  workspaceId: string
  backfillName: string
  params?: unknown
}

/**
 * Generic backfill chunk job. Carries one chunk descriptor produced by the
 * plan worker. `chunk` is opaque definition-specific data handed to the named
 * backfill's `processChunk`. `runId`/`chunkIndex` key the `backfill_chunks`
 * row used for exactly-once accounting on redelivery.
 */
export interface BackfillChunkJobData {
  workspaceId: string
  backfillName: string
  runId: string
  chunkIndex: number
  chunk: unknown
}

/**
 * GitHub webhook process job. One per verified delivery forwarded from the
 * control-plane (`POST /internal/github/webhook-events`). Not workspace-scoped —
 * a single GitHub installation can back many workspaces (installs are per org),
 * so `workspaceId` is the sentinel `"system"` and the worker resolves the real
 * workspaces via `workspace_integrations.installation_id`. Carries the wire
 * shape CP sends; the worker derives canonical PR/issue URLs from `payload` and
 * force-refreshes matching link previews. Idempotent: the enqueue keys on
 * `deliveryGuid` (queue-message PK) and the refresh itself is an overwrite, so a
 * redelivered webhook re-runs harmlessly.
 */
export interface GithubWebhookProcessJobData {
  workspaceId: string
  deliveryGuid: string
  eventType: string
  action: string | null
  installationId: string | null
  repositoryFullName: string | null
  payload: Record<string, unknown>
}

/**
 * Trailing GitHub preview refresh job (webhook-storm coalescing). Scheduled when
 * a webhook-driven `refreshLinkPreview` is dropped as debounced: the newest state
 * would otherwise be lost until the next message edit. `processAfter` is set past
 * the debounce window and the queue-message id is keyed on `(previewId, fetchedAt)`
 * so a burst of deliveries collapses into ONE trailing refresh. The job re-runs
 * `refreshLinkPreview`; if it debounces again (another refresh landed meanwhile),
 * it reschedules once more on the fresh `fetchedAt`, converging when the storm ends.
 */
export interface GithubPreviewRefreshJobData {
  workspaceId: string
  previewId: string
  /**
   * Number of `fetch_empty` retries already made for this preview (GitHub 5xx /
   * timeout / rate-limit breaker). 0/undefined on the first attempt; bounded
   * trailing retries increment it up to a hard cap so a transient fetch failure
   * can't permanently drop the webhook invalidation.
   */
  attempt?: number
  /** Stable across one bounded fetch retry chain; fresh for a later outage cycle. */
  retryCycleId?: string
  /**
   * Debounce-hop counter for a trailing refresh chain. 0/undefined on the bare
   * `_vN` job scheduled by webhook-side senders (they coalesce on that id). When a
   * trailing worker re-debounces at the SAME `refreshVersion` it reschedules with an
   * incremented hop so the new message id (`_vN_h1`, `_vN_h2`, …) can't pkey-dedupe
   * against the very row it just claimed under replica clock skew (PR #1358). Capped
   * to stop an infinite skew loop.
   */
  hop?: number
}

/**
 * Best-effort conditional refresh of one link preview because a client reported
 * its card in the viewport. No retries or trailing chains — the next viewport
 * pass re-nudges. Senders key the queue-message id on a debounce-window time
 * bucket so a scroll-storm across replicas collapses into one job per window.
 */
export interface LinkPreviewVisibleRefreshJobData {
  workspaceId: string
  previewId: string
}

export interface JobDataMap {
  [JobQueues.PERSONA_AGENT]: PersonaAgentJobData
  [JobQueues.DYNAMIC_NAMING_EVALUATE]: DynamicNamingEvaluateJobData
  [JobQueues.EMBEDDING_GENERATE]: EmbeddingJobData
  [JobQueues.BOUNDARY_EXTRACT]: BoundaryExtractionJobData
  [JobQueues.CONVERSATION_STALENESS_SWEEP]: ConversationStalenessSweepJobData
  [JobQueues.ATTACHMENT_UPLOAD_SWEEP]: AttachmentUploadSweepJobData
  [JobQueues.MEMO_BATCH_CHECK]: MemoBatchCheckJobData
  [JobQueues.MEMO_BATCH_PROCESS]: MemoBatchProcessJobData
  [JobQueues.COMMAND_EXECUTE]: CommandExecuteJobData
  [JobQueues.IMAGE_CAPTION]: ImageCaptionJobData
  [JobQueues.IMAGE_THUMBNAIL]: ImageThumbnailJobData
  [JobQueues.PDF_PREPARE]: PdfPrepareJobData
  [JobQueues.PDF_PROCESS_PAGE]: PdfProcessPageJobData
  [JobQueues.PDF_ASSEMBLE]: PdfAssembleJobData
  [JobQueues.TEXT_PROCESS]: TextProcessJobData
  [JobQueues.WORD_PROCESS]: WordProcessJobData
  [JobQueues.EXCEL_PROCESS]: ExcelProcessJobData
  [JobQueues.ATTACHMENT_EMBED]: AttachmentEmbeddingJobData
  [JobQueues.CONVERSATION_EMBEDDING_GENERATE]: ConversationEmbeddingJobData
  [JobQueues.AVATAR_PROCESS]: AvatarProcessJobData
  [JobQueues.LINK_PREVIEW_EXTRACT]: LinkPreviewExtractJobData
  [JobQueues.VIDEO_TRANSCODE_SUBMIT]: VideoTranscodeSubmitJobData
  [JobQueues.VIDEO_TRANSCODE_CHECK]: VideoTranscodeCheckJobData
  [JobQueues.SAVED_REMINDER_FIRE]: SavedReminderFireJobData
  [JobQueues.SCHEDULED_MESSAGE_SEND]: ScheduledMessageSendJobData
  [JobQueues.AGENT_FOLLOW_UP_FIRE]: AgentFollowUpFireJobData
  [JobQueues.AGENT_EPISODE_SUMMARIZE]: AgentEpisodeSummarizeJobData
  [JobQueues.AGENT_REFLECTIVE_CAPTURE]: AgentReflectiveCaptureJobData
  [JobQueues.CONTEXT_BAG_PRECOMPUTE]: ContextBagPrecomputeJobData
  [JobQueues.BACKFILL_PLAN]: BackfillPlanJobData
  [JobQueues.BACKFILL_CHUNK]: BackfillChunkJobData
  [JobQueues.GITHUB_WEBHOOK_PROCESS]: GithubWebhookProcessJobData
  [JobQueues.GITHUB_PREVIEW_REFRESH]: GithubPreviewRefreshJobData
  [JobQueues.LINK_PREVIEW_VISIBLE_REFRESH]: LinkPreviewVisibleRefreshJobData
}

/** Returns void on success, throws on error. */
export type JobHandler<T> = (job: Job<T>) => Promise<void>

/** Metadata about the queue message, available to DLQ hooks. */
export interface QueueMessageMeta {
  /** How many times the message failed before going to DLQ */
  failedCount: number
  /** When the message was originally enqueued */
  insertedAt: Date
  /** Workspace the message belongs to */
  workspaceId: string
}

/**
 * Hook called when a message is moved to DLQ.
 *
 * Runs in a savepoint within the DLQ transaction:
 * - Hook writes only persist if the DLQ move commits
 * - If the hook throws, only the hook's changes are rolled back
 * - The DLQ move still commits (hook failure doesn't brick the queue)
 *
 * Hooks should be idempotent since they may be retried on transient failures.
 */
export type OnDLQHook<T> = (
  querier: import("../../db").Querier,
  job: Job<T>,
  error: Error,
  meta: QueueMessageMeta
) => Promise<void>

export interface HandlerHooks<T> {
  /** Called when message is moved to DLQ after exhausting retries */
  onDLQ?: OnDLQHook<T>
}

/**
 * Tiers group queues by how they share a concurrency budget.
 *
 * - `interactive` — user-facing work that should run as soon as possible
 *   (persona.agent responses, slash commands). Highest default parallelism.
 * - `light` — fast background jobs that don't block on LLMs or large IO
 *   (naming, embeddings, link previews, avatar processing). High parallelism.
 * - `heavy` — slow, IO-bound or CPU-bound jobs (PDF/doc/image processing,
 *   batched memo extraction). Capped low so they can't monopolize DB pool
 *   connections or the event loop while interactive work is waiting.
 */
export const QueueTiers = {
  INTERACTIVE: "interactive",
  LIGHT: "light",
  HEAVY: "heavy",
} as const

export type QueueTier = (typeof QueueTiers)[keyof typeof QueueTiers]

/**
 * Fairness policy for token leasing.
 *
 * - `none` — allows multiple concurrent tokens per `(queue_name, workspace_id)`
 *   pair, so a single workspace can use the full tier budget for that queue.
 *   Correct default because region-level sharding already isolates tenants.
 * - `workspace` — tokens lease one per `(queue_name, workspace_id)` pair,
 *   preventing one workspace from starving others on the same instance.
 *   Use for queues that could be abused by a single workspace.
 */
export const QueueFairness = {
  NONE: "none",
  WORKSPACE: "workspace",
} as const

export type QueueFairnessMode = (typeof QueueFairness)[keyof typeof QueueFairness]

export interface HandlerOptions<T> {
  hooks?: HandlerHooks<T>
  /** Tier controlling which concurrency budget this queue draws from. */
  tier?: QueueTier
  /** Fairness policy for leasing tokens (default: none). */
  fairness?: QueueFairnessMode
  /**
   * Per-queue retry budget before a failing job moves to the DLQ, overriding
   * the manager-wide default. Raise it for queues whose failures are expected
   * to heal on their own — e.g. an enclave turn parked until the owner's
   * client revives a stale key wrap — where the default budget (~8s of
   * exponential backoff) gives the healer no time to act.
   */
  maxRetries?: number
}
