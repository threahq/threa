/**
 * Wire types for domain entities.
 *
 * These types represent the JSON format sent over HTTP/WebSocket.
 * - Timestamps are ISO 8601 strings
 * - BigInt sequences are strings
 *
 * Backend serializes Date/BigInt to these formats before sending.
 * Frontend uses these types directly.
 */

import type {
  BotTrait,
  StreamType,
  Visibility,
  CompanionMode,
  AuthorType,
  EventType,
  WorkspaceRoleSlug,
  InvitationStatus,
  NotificationLevel,
  PersonaManagedBy,
  PersonaStatus,
  StorageProvider,
  ProcessingStatus,
  AttachmentSafetyStatus,
  ConversationStatus,
  MemoType,
  KnowledgeType,
  MemoStatus,
  PendingItemType,
  SourceType,
  ExtractionContentType,
  ExtractionSourceType,
  PdfSizeTier,
  TextFormat,
  TextSizeTier,
  InjectionStrategy,
  LinkPreviewContentType,
  LinkPreviewStatus,
  WorkspaceIntegrationProvider,
  WorkspaceIntegrationStatus,
  GitHubPreviewType,
  LinearPreviewType,
  BotRuntimeKind,
  BotRuntimeSessionLinkStatus,
  BotRuntimeStatus,
  BotInvocationStatus,
  BotInvocationTrigger,
  BotInvocationCapability,
} from "./constants"
import type { ThreaDocument } from "./prosemirror"

export interface Workspace {
  id: string
  name: string
  slug: string
  region?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface User {
  id: string
  workspaceId: string
  workosUserId: string
  email: string
  role: WorkspaceRoleSlug
  slug: string
  name: string
  description: string | null
  avatarUrl: string | null
  timezone: string | null
  locale: string | null
  pronouns: string | null
  phone: string | null
  githubUsername: string | null
  setupCompleted: boolean
  joinedAt: string
}

/**
 * Get the display URL for an avatar image.
 * avatarUrl stores the S3 key base path (avatars/{workspaceId}/{userId}/{timestamp}).
 * This constructs a workspace-scoped backend URL that serves the image.
 */
export function getAvatarUrl(
  workspaceId: string,
  avatarUrl: string | null | undefined,
  size: 256 | 64
): string | undefined {
  if (!avatarUrl) return undefined

  const match = avatarUrl.match(/^avatars\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!match) {
    console.error(`Malformed avatarUrl: "${avatarUrl}" (expected avatars/{workspaceId}/{userId}/{timestamp})`)
    return undefined
  }

  const [, embeddedWorkspaceId, userId, timestamp] = match
  if (embeddedWorkspaceId !== workspaceId) {
    console.error(`avatarUrl workspaceId mismatch: key has "${embeddedWorkspaceId}" but received "${workspaceId}"`)
    return undefined
  }

  return `/api/workspaces/${workspaceId}/users/${userId}/avatar/${timestamp}.${size}.webp`
}

/**
 * Get the display URL for a bot avatar image.
 * avatarUrl stores the S3 key base path (avatars/{workspaceId}/bots/{botId}/{timestamp}).
 */
export function getBotAvatarUrl(
  workspaceId: string,
  avatarUrl: string | null | undefined,
  size: 256 | 64
): string | undefined {
  if (!avatarUrl) return undefined

  const match = avatarUrl.match(/^avatars\/([^/]+)\/bots\/([^/]+)\/([^/]+)$/)
  if (!match) {
    console.error(`Malformed bot avatarUrl: "${avatarUrl}" (expected avatars/{workspaceId}/bots/{botId}/{timestamp})`)
    return undefined
  }

  const [, embeddedWorkspaceId, botId, timestamp] = match
  if (embeddedWorkspaceId !== workspaceId) {
    console.error(`Bot avatarUrl workspaceId mismatch: key has "${embeddedWorkspaceId}" but received "${workspaceId}"`)
    return undefined
  }

  return `/api/workspaces/${workspaceId}/bots/${botId}/avatar/${timestamp}.${size}.webp`
}

export type WorkspaceInvitationKind = "email" | "link"

export interface WorkspaceInvitation {
  id: string
  workspaceId: string
  /** `'email'` invites have an email at creation; `'link'` invites bind email at claim time. */
  kind: WorkspaceInvitationKind
  /** Null until a `'link'` invite is claimed by a recipient. */
  email: string | null
  role: WorkspaceRoleSlug
  invitedBy: string
  status: InvitationStatus
  /** Admin-only memo. Only set on `'link'` invites; never returned by public surfaces. */
  note: string | null
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
}

export interface Stream {
  id: string
  workspaceId: string
  type: StreamType
  displayName: string | null
  slug: string | null
  description: string | null
  visibility: Visibility
  parentStreamId: string | null
  parentMessageId: string | null
  rootStreamId: string | null
  companionMode: CompanionMode
  companionPersonaId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

/** Preview of the last message in a stream for sidebar display */
export interface LastMessagePreview {
  authorId: string
  authorType: AuthorType
  content: string
  createdAt: string
}

/** Stream with optional last message preview, for sidebar listing */
export interface StreamWithPreview extends Stream {
  lastMessagePreview: LastMessagePreview | null
}

export interface StreamActiveActor {
  id: string
  workspaceId: string
  rootStreamId: string
  actorType: "persona" | "bot"
  actorId: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface BotRuntimeInstance {
  id: string
  workspaceId: string
  botId: string
  runtimeKind: BotRuntimeKind
  instanceId: string
  displayName: string | null
  status: BotRuntimeStatus
  acceptingInvocations: boolean
  capabilities: Record<string, unknown>
  statusText: string | null
  lastSeenAt: string
  createdAt: string
  updatedAt: string
}

export interface BotRuntimeSessionLink {
  id: string
  workspaceId: string
  botId: string
  runtimeKind: BotRuntimeKind
  instanceId: string
  runtimeSessionId: string
  rootStreamId: string
  activeStreamId: string
  status: BotRuntimeSessionLinkStatus
  linkedBy: string
  metadata: Record<string, unknown>
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

export interface BotInvocation {
  id: string
  workspaceId: string
  rootStreamId: string
  activeStreamId: string
  sourceMessageId: string
  responseStreamId: string
  actorType: "bot"
  actorId: string
  trigger: BotInvocationTrigger
  requiredCapability: BotInvocationCapability
  promptMarkdown: string
  authorUserId: string
  mentionedActorSlugs: string[]
  status: BotInvocationStatus
  targetInstanceId: string | null
  targetRuntimeSessionId: string | null
  claimedByInstanceId: string | null
  claimToken: string | null
  claimExpiresAt: string | null
  attempts: number
  errorMessage: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface StreamMember {
  streamId: string
  memberId: string
  pinned: boolean
  pinnedAt: string | null
  notificationLevel: NotificationLevel | null
  lastReadEventId: string | null
  lastReadAt: string | null
  joinedAt: string
}

/**
 * Aggregate of the thread rooted at a parent message, attached to message
 * read payloads so the timeline's thread card can render latest-reply preview
 * + participant avatars without another round-trip. Null when the message has
 * no thread or zero non-deleted replies.
 *
 * `latestReply.contentMarkdown` is raw markdown — frontend must strip via
 * `stripMarkdownToInline()` before rendering (INV-60).
 */
export interface ThreadSummary {
  lastReplyAt: string
  /**
   * Distinct actors (users, personas, bots) who have posted in the thread,
   * capped at 3 (backend enforced), ordered by first reply. Includes
   * `actorType` so the frontend can resolve persona/bot avatars — filtering
   * to users-only would hide Ariadne and other personas from the avatar
   * stack even though they're legitimate thread participants.
   */
  participants: Array<{ id: string; type: AuthorType }>
  latestReply: {
    messageId: string
    actorId: string
    actorType: AuthorType
    contentMarkdown: string
  }
}

export interface Message {
  id: string
  streamId: string
  sequence: string
  authorId: string
  authorType: AuthorType
  contentJson: ThreaDocument
  contentMarkdown: string
  replyCount: number
  /**
   * Aggregated thread preview. Absent when the message has no replies; omitted
   * on write-path responses (create/edit/react) where computing it would cost a
   * second query for no benefit. Populated on bootstrap reads.
   */
  threadSummary?: ThreadSummary
  sentVia: string | null
  reactions: Record<string, string[]>
  /**
   * Arbitrary key/value references attached by the sender (e.g. external system IDs).
   * Keys under `threa.*` are reserved for system-generated metadata.
   * Queried with AND-containment semantics via the public API.
   */
  metadata: Record<string, string>
  editedAt: string | null
  deletedAt: string | null
  createdAt: string
}

export interface MessageVersion {
  id: string
  messageId: string
  versionNumber: number
  contentJson: ThreaDocument
  contentMarkdown: string
  editedBy: string
  createdAt: string
}

export interface StreamEvent {
  id: string
  streamId: string
  sequence: string
  eventType: EventType
  payload: unknown
  actorId: string | null
  actorType: AuthorType | null
  createdAt: string
}

export interface Persona {
  id: string
  workspaceId: string | null
  slug: string
  name: string
  description: string | null
  avatarEmoji: string | null
  systemPrompt: string | null
  model: string
  temperature: number | null
  maxTokens: number | null
  enabledTools: string[] | null
  managedBy: PersonaManagedBy
  status: PersonaStatus
  createdAt: string
  updatedAt: string
}

interface BotBase {
  id: string
  workspaceId: string
  /** Capability tags (e.g. `["interactive"]`). See BOT_TRAITS for the vocabulary. */
  traits: BotTrait[]
  slug: string | null
  name: string
  description: string | null
  avatarEmoji: string | null
  avatarUrl: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Discriminated on `type`:
 * - `shared` bots are admin-managed and workspace-wide; `ownerUserId` is `null`.
 * - `personal` bots are owned by one user, who alone can manage them and grant
 *   them stream access; `ownerUserId` is non-null.
 */
export type Bot =
  | (BotBase & { type: "shared"; ownerUserId: null })
  | (BotBase & { type: "personal"; ownerUserId: string })

export interface Attachment {
  id: string
  workspaceId: string
  streamId: string | null
  messageId: string | null
  uploadedBy: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  storageProvider: StorageProvider
  processingStatus: ProcessingStatus
  safetyStatus: AttachmentSafetyStatus
  createdAt: string
}

/**
 * Lightweight attachment info included in message events.
 * Contains only what's needed for display; download URLs fetched on-demand.
 */
export interface AttachmentSummary {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  /** Present for video attachments so the frontend knows transcoding state */
  processingStatus?: ProcessingStatus
  /**
   * Orientation-corrected intrinsic pixel dimensions for image attachments.
   * Present once the thumbnail worker has run; lets the UI reserve the image
   * box before any bytes load (no layout shift, no progressive reveal).
   */
  width?: number
  height?: number
}

/**
 * Source reference for message citations.
 * Used by agents to provide sources for their responses.
 */
export interface SourceItem {
  /** Source type: web for external URLs, workspace for internal knowledge */
  type?: SourceType
  /** Display title of the source */
  title: string
  /** URL to the source (web URL or internal navigation link) */
  url: string
  /** Optional preview snippet of the source content */
  snippet?: string
}

export interface Conversation {
  id: string
  streamId: string
  workspaceId: string
  messageIds: string[]
  participantIds: string[]
  topicSummary: string | null
  completenessScore: number
  confidence: number
  status: ConversationStatus
  parentConversationId: string | null
  lastActivityAt: string
  createdAt: string
  updatedAt: string
}

/**
 * Conversation with computed temporal staleness.
 * Staleness is computed on read based on lastActivityAt.
 */
export interface ConversationWithStaleness extends Conversation {
  temporalStaleness: number
  effectiveCompleteness: number
}

/**
 * Memo: Semantic pointer to valuable knowledge.
 * Following GAM paper: lightweight abstracts that guide retrieval at runtime.
 */
export interface Memo {
  id: string
  workspaceId: string
  memoType: MemoType
  sourceMessageId: string | null
  sourceConversationId: string | null
  title: string
  abstract: string
  keyPoints: string[]
  sourceMessageIds: string[]
  participantIds: string[]
  knowledgeType: KnowledgeType
  tags: string[]
  parentMemoId: string | null
  status: MemoStatus
  version: number
  revisionReason: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

/**
 * Pending item in the memo processing queue.
 * Per-stream grouping for debounced batch processing.
 */
export interface PendingMemoItem {
  id: string
  workspaceId: string
  streamId: string
  itemType: PendingItemType
  itemId: string
  queuedAt: string
  processedAt: string | null
}

/**
 * Stream state for memo debounce logic.
 * Tracks last activity and processing times per stream.
 */
export interface MemoStreamState {
  workspaceId: string
  streamId: string
  lastProcessedAt: string | null
  lastActivityAt: string
}

/**
 * Structured data extracted from charts.
 * Fields use `| null` to match Zod schema output.
 */
export interface ChartData {
  chartType: string
  title: string | null
  axes: { x: string | null; y: string | null } | null
  dataPoints: Array<{ label: string; value: string | number }> | null
  trends: string[] | null
}

/**
 * Structured data extracted from tables.
 * Fields use `| null` to match Zod schema output.
 */
export interface TableData {
  headers: string[]
  rows: string[][]
  summary: string | null
}

/**
 * Structured data extracted from diagrams.
 * Fields use `| null` to match Zod schema output.
 */
export interface DiagramData {
  diagramType: string
  nodes: Array<{ id: string; label: string }> | null
  connections: Array<{ from: string; to: string; label: string | null }> | null
  description: string | null
}

/**
 * Section within a PDF document for large PDF navigation.
 */
export interface PdfSection {
  startPage: number
  endPage: number
  title: string
}

/**
 * Metadata for PDF extractions.
 */
export interface PdfMetadata {
  totalPages: number
  sizeTier: PdfSizeTier
  sections: PdfSection[]
}

/**
 * Section within a text file for large file navigation.
 */
export interface TextSection {
  /** Section type: "heading" for markdown, "key" for JSON, "rows" for CSV, "lines" for plain text */
  type: "heading" | "key" | "rows" | "lines"
  /** Section identifier (heading path, JSON key path, row range, line range) */
  path: string
  /** Human-readable title for the section */
  title: string
  /** Start line (0-indexed) */
  startLine: number
  /** End line (0-indexed, exclusive) */
  endLine: number
}

/**
 * Markdown-specific structure.
 */
export interface MarkdownStructure {
  /** Table of contents (heading paths) */
  toc: string[]
  /** Whether file contains code blocks */
  hasCodeBlocks: boolean
  /** Whether file contains tables */
  hasTables: boolean
}

/**
 * JSON-specific structure.
 */
export interface JsonStructure {
  /** Root type: object, array, or primitive */
  rootType: "object" | "array" | "primitive"
  /** Top-level keys (for objects) */
  topLevelKeys: string[] | null
  /** Array length (for arrays) */
  arrayLength: number | null
  /** Inferred schema description */
  schemaDescription: string | null
}

/**
 * CSV-specific structure.
 */
export interface CsvStructure {
  /** Column headers */
  headers: string[]
  /** Total row count (excluding header) */
  rowCount: number
  /** Sample of first few rows */
  sampleRows: string[][]
}

/**
 * Code-specific structure.
 */
export interface CodeStructure {
  /** Detected programming language */
  language: string
  /** Exports/definitions found */
  exports: string[] | null
  /** Import statements found */
  imports: string[] | null
}

/**
 * Metadata for text file extractions.
 */
export interface TextMetadata {
  format: TextFormat
  sizeTier: TextSizeTier
  injectionStrategy: InjectionStrategy
  totalLines: number
  totalBytes: number
  encoding: string
  sections: TextSection[]
  /** Format-specific structure (null for plain text) */
  structure: MarkdownStructure | JsonStructure | CsvStructure | CodeStructure | null
}

/**
 * Metadata for Word document extractions.
 */
export interface WordMetadata {
  /** Document format: "docx" (Open XML) or "doc" (legacy binary) */
  format: "docx" | "doc"
  /** Size tier based on extracted content */
  sizeTier: TextSizeTier
  /** How content should be injected into AI context */
  injectionStrategy: InjectionStrategy
  /** Page count from document properties (null if not available) */
  pageCount: number | null
  /** Total word count */
  wordCount: number
  /** Total character count */
  characterCount: number
  /** Document author from properties (null if not available) */
  author: string | null
  /** Document creation date from properties (null if not available) */
  createdAt: string | null
  /** Document last modified date from properties (null if not available) */
  modifiedAt: string | null
  /** Number of embedded images processed */
  embeddedImageCount: number
  /** Section structure for navigation (same format as text files) */
  sections: TextSection[]
}

/**
 * Sheet info within an Excel workbook.
 */
export interface ExcelSheetInfo {
  name: string
  rows: number
  columns: number
  headers: string[]
  columnTypes: string[]
  sampleRows: string[][]
}

/**
 * Chart info within an Excel workbook.
 */
export interface ExcelChartInfo {
  sheetName: string
  type: string | null
  title: string | null
  description: string
}

/**
 * Metadata for Excel workbook extractions.
 */
export interface ExcelMetadata {
  /** Document format: "xlsx" (Open XML) or "xls" (legacy binary) */
  format: "xlsx" | "xls"
  /** Size tier based on total cells */
  sizeTier: TextSizeTier
  /** How content should be injected into AI context */
  injectionStrategy: InjectionStrategy
  /** Total number of sheets */
  totalSheets: number
  /** Total rows across all sheets */
  totalRows: number
  /** Total cells across all sheets */
  totalCells: number
  /** Workbook author from properties (null if not available) */
  author: string | null
  /** Workbook creation date from properties (null if not available) */
  createdAt: string | null
  /** Workbook last modified date from properties (null if not available) */
  modifiedAt: string | null
  /** Per-sheet info */
  sheets: ExcelSheetInfo[]
  /** Chart info */
  charts: ExcelChartInfo[]
}

/**
 * Extracted content from an attachment (images, documents, etc.).
 * Created by image captioning pipeline for AI agent context.
 */
export interface AttachmentExtraction {
  id: string
  attachmentId: string
  workspaceId: string
  contentType: ExtractionContentType
  summary: string
  fullText: string | null
  structuredData: ChartData | TableData | DiagramData | null
  sourceType: ExtractionSourceType
  pdfMetadata: PdfMetadata | null
  textMetadata: TextMetadata | null
  wordMetadata: WordMetadata | null
  excelMetadata: ExcelMetadata | null
  createdAt: string
  updatedAt: string
}

// =============================================================================
// Link Previews
// =============================================================================

/**
 * Cached metadata for a URL found in a message.
 * Fetched server-side by background worker.
 */
export interface LinkPreview {
  id: string
  workspaceId: string
  url: string
  normalizedUrl: string
  title: string | null
  description: string | null
  imageUrl: string | null
  faviconUrl: string | null
  siteName: string | null
  contentType: LinkPreviewContentType
  status: LinkPreviewStatus
  previewType?: GitHubPreviewType | LinearPreviewType | null
  previewData?: GitHubPreview | LinearPreview | null
  fetchedAt: string | null
  expiresAt?: string | null
  createdAt: string
}

/**
 * Lightweight link preview info included in message event payloads.
 * Contains what's needed for display; full data fetched on-demand if needed.
 */
export interface LinkPreviewSummary {
  id: string
  url: string
  title: string | null
  description: string | null
  imageUrl: string | null
  faviconUrl: string | null
  siteName: string | null
  contentType: LinkPreviewContentType
  previewType?: GitHubPreviewType | LinearPreviewType | null
  previewData?: GitHubPreview | LinearPreview | null
  position: number
}

// =============================================================================
// Workspace Integrations
// =============================================================================

export interface WorkspaceIntegration {
  id: string
  workspaceId: string
  provider: WorkspaceIntegrationProvider
  status: WorkspaceIntegrationStatus
  installedBy: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceIntegrationRateLimit {
  remaining: number | null
  resetAt: string | null
}

export interface GitHubInstalledRepository {
  fullName: string
  private: boolean
}

export interface GitHubWorkspaceIntegration extends WorkspaceIntegration {
  provider: "github"
  organizationName: string | null
  repositorySelection: "all" | "selected" | null
  permissions: Record<string, string>
  repositories: GitHubInstalledRepository[]
  rateLimit: WorkspaceIntegrationRateLimit
}

export interface LinearAuthorizedUser {
  id: string
  name: string
  email: string | null
}

export interface LinearRateLimit {
  requestsRemaining: number | null
  requestsResetAt: string | null
  complexityRemaining: number | null
  complexityResetAt: string | null
}

export interface LinearWorkspaceIntegration extends WorkspaceIntegration {
  provider: "linear"
  organizationId: string | null
  organizationName: string | null
  /** The `{workspace}` slug segment in `linear.app/{workspace}/...` URLs. Used to gate preview URL matching. */
  organizationUrlKey: string | null
  authorizedUser: LinearAuthorizedUser | null
  scope: string | null
  rateLimit: LinearRateLimit
}

// =============================================================================
// Rich GitHub Link Previews
// =============================================================================

export interface GitHubPreviewActor {
  login: string
  avatarUrl: string | null
}

export interface GitHubPreviewRepository {
  owner: string
  name: string
  fullName: string
  private: boolean
}

export interface GitHubReviewStatusSummary {
  approvals: number
  changesRequested: number
  comments: number
  pendingReviewers: number
}

export interface GitHubPrPreviewData {
  title: string
  number: number
  state: "open" | "closed" | "merged"
  author: GitHubPreviewActor | null
  baseBranch: string
  headBranch: string
  additions: number
  deletions: number
  reviewStatusSummary: GitHubReviewStatusSummary
  createdAt: string
  updatedAt: string
}

export interface GitHubIssueLabel {
  name: string
  color: string
  description: string | null
}

export interface GitHubIssuePreviewData {
  title: string
  number: number
  state: "open" | "closed"
  author: GitHubPreviewActor | null
  labels: GitHubIssueLabel[]
  assignees: GitHubPreviewActor[]
  commentCount: number
  createdAt: string
  updatedAt: string
}

export interface GitHubCommitPreviewData {
  message: string
  shortSha: string
  author: GitHubPreviewActor | null
  committedAt: string | null
  filesChanged: number
  additions: number
  deletions: number
}

export interface GitHubSnippetLine {
  number: number
  text: string
}

export interface GitHubFilePreviewData {
  path: string
  language: string | null
  ref: string
  renderMode?: "snippet" | "markdown"
  markdownContent?: string | null
  lines: GitHubSnippetLine[]
  startLine: number
  endLine: number
  truncated: boolean
}

export interface GitHubDiffLine {
  type: "context" | "add" | "delete"
  oldNumber: number | null
  newNumber: number | null
  text: string
  selected: boolean
}

export interface GitHubDiffPreviewData {
  path: string
  previousPath: string | null
  language: string | null
  changeType: "added" | "removed" | "modified" | "renamed"
  pullRequest: {
    title: string
    number: number
    state: "open" | "closed" | "merged"
  }
  anchorSide: "left" | "right" | null
  anchorStartLine: number | null
  anchorEndLine: number | null
  additions: number
  deletions: number
  lines: GitHubDiffLine[]
  truncated: boolean
}

export interface GitHubCommentParent {
  kind: "pull_request" | "issue"
  title: string
  number: number
}

export interface GitHubCommentPreviewData {
  body: string
  truncated: boolean
  author: GitHubPreviewActor | null
  createdAt: string
  parent: GitHubCommentParent
}

export interface GitHubPreview {
  type: GitHubPreviewType
  url: string
  repository: GitHubPreviewRepository
  data:
    | GitHubPrPreviewData
    | GitHubIssuePreviewData
    | GitHubCommitPreviewData
    | GitHubFilePreviewData
    | GitHubDiffPreviewData
    | GitHubCommentPreviewData
  fetchedAt: string
}

// =============================================================================
// Rich Linear Link Previews
// =============================================================================

export interface LinearActor {
  id: string
  name: string
  displayName: string
  avatarUrl: string | null
}

export interface LinearTeam {
  key: string
  name: string
}

/**
 * Linear workflow state. `type` is the canonical state kind (triage, backlog, unstarted,
 * started, completed, canceled) — render state badges via `color` (hex without `#`) so
 * workspace-specific state colors round-trip correctly.
 */
export interface LinearIssueState {
  name: string
  type: string
  color: string
}

export interface LinearIssueLabel {
  name: string
  color: string
}

export interface LinearOrganizationSummary {
  id: string
  urlKey: string
  name: string
}

export interface LinearIssuePreviewData {
  identifier: string
  title: string
  summary: string | null
  state: LinearIssueState
  priority: { label: string; value: number } | null
  team: LinearTeam
  assignee: LinearActor | null
  labels: LinearIssueLabel[]
  estimate: number | null
  dueDate: string | null
  projectName: string | null
  createdAt: string
  updatedAt: string
}

export interface LinearCommentParent {
  identifier: string
  title: string
  state: LinearIssueState
  team: LinearTeam
}

export interface LinearCommentPreviewData {
  body: string
  truncated: boolean
  author: LinearActor | null
  createdAt: string
  parent: LinearCommentParent
}

export interface LinearProjectPreviewData {
  name: string
  description: string | null
  status: string
  progress: number
  lead: LinearActor | null
  initiativeName: string | null
  targetDate: string | null
  startDate: string | null
}

export interface LinearDocumentPreviewData {
  title: string
  summary: string | null
  updatedBy: LinearActor | null
  createdAt: string
  updatedAt: string
  parentProject: { id: string; name: string } | null
}

export interface LinearPreview {
  type: LinearPreviewType
  url: string
  organization: LinearOrganizationSummary
  data: LinearIssuePreviewData | LinearCommentPreviewData | LinearProjectPreviewData | LinearDocumentPreviewData
  fetchedAt: string
}

// =============================================================================
// Message Link Previews (internal permalinks)
// =============================================================================

/** Access tiers for message link previews, resolved per-viewer at render time. */
export type MessageLinkAccessTier = "full" | "private" | "cross_workspace"

/**
 * Resolved message link preview data returned by the permission-checked resolve endpoint.
 * Content fields are only populated for the "full" access tier.
 */
export interface MessageLinkPreviewData {
  accessTier: MessageLinkAccessTier
  /** Author display name (full tier only) */
  authorName?: string
  /** Author avatar URL path (full tier only) */
  authorAvatarUrl?: string
  /** Truncated message content (full tier only) */
  contentPreview?: string
  /** Stream display name (full tier only) */
  streamName?: string
  /** Whether the target message has been deleted */
  deleted?: boolean
}
