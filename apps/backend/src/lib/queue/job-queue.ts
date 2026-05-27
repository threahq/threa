/**
 * Job queue types for the custom queue system.
 *
 * These types are used by QueueManager (queue-manager.ts) and all job workers.
 */

import { AgentTriggers, type AgentSessionRerunContext } from "@threa/types"

/**
 * Job object passed to handlers.
 */
export interface Job<T = unknown> {
  id: string
  name: string
  data: T
}

// Job type definitions
export const JobQueues = {
  PERSONA_AGENT: "persona.agent",
  ENCLAVE_PERSONA_AGENT: "persona.enclave_agent",
  NAMING_GENERATE: "naming.generate",
  EMBEDDING_GENERATE: "embedding.generate",
  BOUNDARY_EXTRACT: "boundary.extract",
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
  AVATAR_PROCESS: "avatar.process",
  LINK_PREVIEW_EXTRACT: "link_preview.extract",
  VIDEO_TRANSCODE_SUBMIT: "video.transcode_submit",
  VIDEO_TRANSCODE_CHECK: "video.transcode_check",
  SAVED_REMINDER_FIRE: "saved.reminder_fire",
  SCHEDULED_MESSAGE_SEND: "scheduled_message.send",
  CONTEXT_BAG_PRECOMPUTE: "context_bag.precompute",
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
}

/**
 * Enclave persona agent job — dispatches a persona invocation in an E2E
 * scratchpad to the side-project enclave service. The worker for this queue
 * does NOT run AgentRuntime itself; it loads ciphertext history + recipients,
 * POSTs to a live enclave instance's /invoke, and writes the sealed reply.
 *
 * The shape mirrors PersonaAgentJobData minus the rerun/supersede fields
 * (5a is always-on companion mode; @-mention and rerun aren't wired yet).
 */
export interface EnclavePersonaAgentJobData {
  workspaceId: string
  streamId: string
  messageId: string
  personaId: string
  triggeredBy: string
}

export interface NamingJobData {
  workspaceId: string
  streamId: string
  /** If true, must generate a name (no NOT_ENOUGH_CONTEXT escape). Set when message is from agent. */
  requireName: boolean
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

// Map queue names to their data types
export interface JobDataMap {
  [JobQueues.PERSONA_AGENT]: PersonaAgentJobData
  [JobQueues.ENCLAVE_PERSONA_AGENT]: EnclavePersonaAgentJobData
  [JobQueues.NAMING_GENERATE]: NamingJobData
  [JobQueues.EMBEDDING_GENERATE]: EmbeddingJobData
  [JobQueues.BOUNDARY_EXTRACT]: BoundaryExtractionJobData
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
  [JobQueues.AVATAR_PROCESS]: AvatarProcessJobData
  [JobQueues.LINK_PREVIEW_EXTRACT]: LinkPreviewExtractJobData
  [JobQueues.VIDEO_TRANSCODE_SUBMIT]: VideoTranscodeSubmitJobData
  [JobQueues.VIDEO_TRANSCODE_CHECK]: VideoTranscodeCheckJobData
  [JobQueues.SAVED_REMINDER_FIRE]: SavedReminderFireJobData
  [JobQueues.SCHEDULED_MESSAGE_SEND]: ScheduledMessageSendJobData
  [JobQueues.CONTEXT_BAG_PRECOMPUTE]: ContextBagPrecomputeJobData
}

/**
 * Handler for a single job. Returns void on success, throws on error.
 */
export type JobHandler<T> = (job: Job<T>) => Promise<void>

/**
 * Metadata about the queue message, available to DLQ hooks.
 */
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

/**
 * Lifecycle hooks for job handlers.
 */
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

/**
 * Options for registering a job handler.
 */
export interface HandlerOptions<T> {
  hooks?: HandlerHooks<T>
  /** Tier controlling which concurrency budget this queue draws from. */
  tier?: QueueTier
  /** Fairness policy for leasing tokens (default: none). */
  fairness?: QueueFairnessMode
}
