/**
 * Public API route registry — the single source of truth for OpenAPI spec generation.
 *
 * Every public API endpoint MUST be registered here. The generator script reads this
 * registry at build time and produces the OpenAPI 3.0 spec. Adding a route to routes.ts
 * but not here is a build error (caught by the pre-commit drift check).
 */
import { z } from "zod"
import {
  BOT_INVOCATION_CAPABILITIES,
  BOT_INVOCATION_TRIGGERS,
  BOT_RUNTIME_KINDS,
  BOT_RUNTIME_STATUSES,
  BOT_TRAITS,
  WORKSPACE_PERMISSION_SCOPES,
  STREAM_TYPES,
  AUTHOR_TYPES,
  MEMO_TYPES,
  KNOWLEDGE_TYPES,
  PROCESSING_STATUSES,
  EXTRACTION_CONTENT_TYPES,
} from "@threa/types"
import type { WorkspacePermissionSlug } from "@threa/types"
import {
  publicSearchSchema,
  listMyBotsSchema,
  listStreamsSchema,
  listMessagesSchema,
  sendMessageSchema,
  updateMessageSchema,
  listMembersSchema,
  listUsersSchema,
  searchMemosSchema,
  searchAttachmentsSchema,
  findMessagesByMetadataSchema,
  upsertPresenceSchema,
  claimInvocationSchema,
  completeInvocationSchema,
  failInvocationSchema,
} from "./schemas"

// ---------------------------------------------------------------------------
// Response schemas — the single source of truth for public API wire shapes.
// Serializer return types are derived from these schemas (see WireStream etc.)
// so any drift between docs and runtime is a compile-time error.
// ---------------------------------------------------------------------------

const streamSchema = z.object({
  id: z.string(),
  type: z.enum(STREAM_TYPES),
  displayName: z.string(),
  slug: z.string().optional(),
  description: z.string().optional(),
  visibility: z.string(),
  parentStreamId: z.string().optional(),
  rootStreamId: z.string().optional(),
  parentMessageId: z.string().optional(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
})

const messageSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  sequence: z.string().describe("Numeric sequence as string"),
  authorId: z.string(),
  authorType: z.enum(AUTHOR_TYPES),
  authorDisplayName: z.string().optional(),
  content: z.string(),
  replyCount: z.number().int(),
  threadStreamId: z.string().optional(),
  clientMessageId: z.string().optional(),
  sentVia: z.string().optional().describe("Present when message was sent via API on behalf of a user"),
  metadata: z
    .record(z.string(), z.string())
    .describe("External references attached by the sender. Always present; empty when unset."),
  editedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
})

const searchResultSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  sequence: z.string().describe("Numeric sequence as string"),
  content: z.string(),
  authorId: z.string(),
  authorType: z.enum(AUTHOR_TYPES),
  authorDisplayName: z.string().optional(),
  replyCount: z.number().int(),
  metadata: z
    .record(z.string(), z.string())
    .describe("External references attached by the sender. Always present; empty when unset."),
  editedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  rank: z.number(),
})

const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  slug: z.string(),
  avatarUrl: z.string().optional(),
  joinedAt: z.string().datetime(),
})

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  email: z.string(),
  avatarUrl: z.string().optional(),
  role: z.string(),
})

// Bot wire schema is a discriminated union so the type/ownerUserId invariant
// (personal ⇒ ownerUserId non-null; shared ⇒ ownerUserId null) is enforced at
// the schema layer and reflected in the generated OpenAPI/client types.
const botCommonFields = {
  id: z.string(),
  workspaceId: z.string(),
  traits: z.array(z.enum(BOT_TRAITS)),
  slug: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  avatarEmoji: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}

const sharedBotSchema = z.object({
  ...botCommonFields,
  type: z.literal("shared"),
  ownerUserId: z.null(),
})

const personalBotSchema = z.object({
  ...botCommonFields,
  type: z.literal("personal"),
  ownerUserId: z.string(),
})

const botSchema = z.discriminatedUnion("type", [sharedBotSchema, personalBotSchema])

// Principal can't use a single-discriminator union because the bot variants
// share `kind: "bot"` but split on `botType`. z.union handles the three-way
// shape correctly; the generated OpenAPI uses `oneOf`, which clients narrow
// on `kind` first and then `botType` for the bot branch.
const principalSchema = z.union([
  z.object({
    kind: z.literal("user"),
    workspaceId: z.string(),
    userId: z.string(),
  }),
  z.object({
    kind: z.literal("bot"),
    workspaceId: z.string(),
    botId: z.string(),
    botType: z.literal("shared"),
    traits: z.array(z.enum(BOT_TRAITS)),
    ownerUserId: z.null(),
  }),
  z.object({
    kind: z.literal("bot"),
    workspaceId: z.string(),
    botId: z.string(),
    botType: z.literal("personal"),
    traits: z.array(z.enum(BOT_TRAITS)),
    ownerUserId: z.string(),
  }),
])

const streamRefSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().nullable(),
})

const memoSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  memoType: z.enum(MEMO_TYPES),
  sourceMessageId: z.string().nullable(),
  sourceConversationId: z.string().nullable(),
  title: z.string(),
  abstract: z.string(),
  keyPoints: z.array(z.string()),
  sourceMessageIds: z.array(z.string()),
  participantIds: z.array(z.string()),
  knowledgeType: z.enum(KNOWLEDGE_TYPES),
  tags: z.array(z.string()),
  parentMemoId: z.string().nullable(),
  status: z.string(),
  version: z.number().int(),
  revisionReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
})

const memoSearchResultSchema = z.object({
  memo: memoSchema,
  distance: z.number(),
  sourceStream: streamRefSchema.nullable(),
  rootStream: streamRefSchema.nullable(),
})

const memoSourceMessageSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  streamName: z.string(),
  authorId: z.string(),
  authorType: z.enum(AUTHOR_TYPES),
  authorName: z.string(),
  content: z.string(),
  createdAt: z.string().datetime(),
})

const memoDetailSchema = memoSearchResultSchema.extend({
  sourceMessages: z.array(memoSourceMessageSchema),
})

const attachmentExtractionSchema = z.object({
  contentType: z.enum(EXTRACTION_CONTENT_TYPES),
  summary: z.string(),
  fullText: z.string().nullable(),
  structuredData: z.unknown().nullable(),
  pdfMetadata: z.unknown().nullable().optional(),
  textMetadata: z.unknown().nullable().optional(),
  wordMetadata: z.unknown().nullable().optional(),
  excelMetadata: z.unknown().nullable().optional(),
})

const attachmentSearchResultSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  contentType: z.enum(EXTRACTION_CONTENT_TYPES).nullable(),
  summary: z.string().nullable(),
  streamId: z.string().optional(),
  messageId: z.string().optional(),
  createdAt: z.string().datetime(),
})

const attachmentDetailsSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  processingStatus: z.enum(PROCESSING_STATUSES),
  createdAt: z.string().datetime(),
  extraction: attachmentExtractionSchema.nullable(),
})

const attachmentUrlSchema = z.object({
  url: z.string().url(),
  expiresIn: z.number().int(),
})

const botRuntimePresenceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  botId: z.string(),
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  instanceId: z.string(),
  displayName: z.string().nullable(),
  status: z.enum(BOT_RUNTIME_STATUSES),
  acceptingInvocations: z.boolean(),
  capabilities: z.record(z.string(), z.unknown()),
  statusText: z.string().nullable(),
  lastSeenAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

const claimedInvocationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  rootStreamId: z.string(),
  activeStreamId: z.string(),
  sourceMessageId: z.string(),
  responseStreamId: z.string(),
  actor: z.object({ type: z.literal("bot"), id: z.string(), slug: z.string() }),
  trigger: z.enum(BOT_INVOCATION_TRIGGERS),
  requiredCapability: z.enum(BOT_INVOCATION_CAPABILITIES),
  promptMarkdown: z.string(),
  authorUserId: z.string(),
  mentionedActorSlugs: z.array(z.string()),
  claimToken: z.string().nullable(),
  claimExpiresAt: z.string().datetime().nullable(),
  runtimeSessionId: z.string().nullable(),
})

const invocationStatusSchema = z.object({ invocationId: z.string(), status: z.string() })
const completedInvocationSchema = z.object({ invocationId: z.string(), message: messageSchema })

const errorSchema = z.object({
  error: z.string(),
  details: z.record(z.string(), z.array(z.string())).optional(),
})

// Paginated wrappers
function paginated(itemSchema: z.ZodType) {
  return z.object({
    data: z.array(itemSchema),
    hasMore: z.boolean(),
    cursor: z.string().nullable(),
  })
}

function dataEnvelope(itemSchema: z.ZodType) {
  return z.object({ data: itemSchema })
}

function dataArrayEnvelope(itemSchema: z.ZodType) {
  return z.object({ data: z.array(itemSchema) })
}

// ---------------------------------------------------------------------------
// Common path parameters
// ---------------------------------------------------------------------------
const workspaceIdParam = {
  name: "workspaceId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Workspace ID (prefixed ULID)",
}

const streamIdParam = {
  name: "streamId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Stream ID (prefixed ULID)",
}

const messageIdParam = {
  name: "messageId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Message ID (prefixed ULID)",
}

const memoIdParam = {
  name: "memoId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Memo ID (prefixed ULID)",
}

const attachmentIdParam = {
  name: "attachmentId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Attachment ID (prefixed ULID)",
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export interface PublicApiRoute {
  method: "get" | "post" | "patch" | "delete"
  path: string
  operationId: string
  summary: string
  description?: string
  tags: string[]
  scopes: WorkspacePermissionSlug[]
  parameters?: Array<{
    name: string
    in: "path" | "query"
    required: boolean
    schema: { type: string }
    description: string
  }>
  /** Zod schema for query parameters (GET) or request body (POST/PATCH) */
  requestSchema?: z.ZodType
  /** Where the request schema applies */
  requestIn?: "query" | "body"
  /** Zod schema for successful response body */
  responseSchema: z.ZodType
  /** HTTP status code for successful response */
  successStatus?: number
  /** Whether the endpoint can return 404 (resource not found) */
  canReturn404?: boolean
}

export const PUBLIC_API_ROUTES: PublicApiRoute[] = [
  // --- Search ---
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/messages/search",
    operationId: "searchMessages",
    summary: "Search messages",
    description: "Full-text and optional semantic search across accessible streams.",
    tags: ["Messages"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_SEARCH],
    parameters: [workspaceIdParam],
    requestSchema: publicSearchSchema,
    requestIn: "body",
    responseSchema: dataArrayEnvelope(searchResultSchema),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/memos/search",
    operationId: "searchMemos",
    summary: "Search memos",
    description: "Search preserved workspace memos with semantic, exact, or recent-first retrieval.",
    tags: ["Memos"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MEMOS_READ],
    parameters: [workspaceIdParam],
    requestSchema: searchMemosSchema,
    requestIn: "body",
    responseSchema: dataArrayEnvelope(memoSearchResultSchema),
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/memos/{memoId}",
    operationId: "getMemo",
    summary: "Get a memo",
    description: "Retrieve a memo together with source stream and source message provenance.",
    tags: ["Memos"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MEMOS_READ],
    parameters: [workspaceIdParam, memoIdParam],
    responseSchema: dataEnvelope(memoDetailSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/attachments/search",
    operationId: "searchAttachments",
    summary: "Search attachments",
    description: "Search accessible attachments by filename or extracted content.",
    tags: ["Attachments"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ],
    parameters: [workspaceIdParam],
    requestSchema: searchAttachmentsSchema,
    requestIn: "body",
    responseSchema: dataArrayEnvelope(attachmentSearchResultSchema),
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/attachments/{attachmentId}",
    operationId: "getAttachment",
    summary: "Get an attachment",
    description: "Retrieve attachment metadata and extracted content for an accessible attachment.",
    tags: ["Attachments"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ],
    parameters: [workspaceIdParam, attachmentIdParam],
    responseSchema: dataEnvelope(attachmentDetailsSchema),
    canReturn404: true,
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/attachments/{attachmentId}/url",
    operationId: "getAttachmentDownloadUrl",
    summary: "Get an attachment download URL",
    description: "Create a short-lived signed URL for an accessible attachment.",
    tags: ["Attachments"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ],
    parameters: [workspaceIdParam, attachmentIdParam],
    responseSchema: dataEnvelope(attachmentUrlSchema),
    canReturn404: true,
  },

  // --- Bot runtimes ---
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-runtime/presence",
    operationId: "upsertBotRuntimePresence",
    summary: "Heartbeat bot runtime presence",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: upsertPresenceSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(botRuntimePresenceSchema),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/claim",
    operationId: "claimBotInvocation",
    summary: "Claim one pending bot invocation",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_READ],
    parameters: [workspaceIdParam],
    requestSchema: claimInvocationSchema,
    requestIn: "body",
    responseSchema: z.object({ data: claimedInvocationSchema.nullable() }),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/complete",
    operationId: "completeBotInvocation",
    summary: "Complete a claimed bot invocation",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
    ],
    requestSchema: completeInvocationSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(completedInvocationSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/fail",
    operationId: "failBotInvocation",
    summary: "Fail a claimed bot invocation",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
    ],
    requestSchema: failInvocationSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(invocationStatusSchema),
    canReturn404: true,
  },

  // --- Streams ---
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/streams",
    operationId: "listStreams",
    summary: "List streams",
    description: "List streams accessible to this API key, with optional type and text filters.",
    tags: ["Streams"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.STREAMS_READ],
    parameters: [workspaceIdParam],
    requestSchema: listStreamsSchema,
    requestIn: "query",
    responseSchema: paginated(streamSchema),
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}",
    operationId: "getStream",
    summary: "Get a stream",
    tags: ["Streams"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.STREAMS_READ],
    parameters: [workspaceIdParam, streamIdParam],
    responseSchema: dataEnvelope(streamSchema),
    canReturn404: true,
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}/members",
    operationId: "listMembers",
    summary: "List stream members",
    tags: ["Streams"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.STREAMS_READ],
    parameters: [workspaceIdParam, streamIdParam],
    requestSchema: listMembersSchema,
    requestIn: "query",
    responseSchema: paginated(memberSchema),
  },

  // --- Messages ---
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}/messages",
    operationId: "listMessages",
    summary: "List messages in a stream",
    description: "Cursor-paginated message list. Use `before` or `after` sequence numbers.",
    tags: ["Messages"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
    parameters: [workspaceIdParam, streamIdParam],
    requestSchema: listMessagesSchema,
    requestIn: "query",
    responseSchema: z.object({
      data: z.array(messageSchema),
      hasMore: z.boolean(),
    }),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}/messages",
    operationId: "sendMessage",
    summary: "Send a message",
    description:
      "Send a message. Workspace-scoped keys send as a bot; user-scoped keys send on behalf of the key owner.",
    tags: ["Messages"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE],
    parameters: [workspaceIdParam, streamIdParam],
    requestSchema: sendMessageSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(messageSchema),
    successStatus: 201,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/messages/find-by-metadata",
    operationId: "findMessagesByMetadata",
    summary: "Find messages by metadata",
    description:
      "Find non-deleted messages whose `metadata` contains all the given key/value pairs (AND-containment). " +
      "Useful for dedup flows — e.g. 'has a message already been posted for this GitHub PR event?'.",
    tags: ["Messages"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
    parameters: [workspaceIdParam],
    requestSchema: findMessagesByMetadataSchema,
    requestIn: "body",
    responseSchema: dataArrayEnvelope(messageSchema),
  },
  {
    method: "patch",
    path: "/api/v1/workspaces/{workspaceId}/messages/{messageId}",
    operationId: "updateMessage",
    summary: "Update a message",
    description: "Update a message you previously sent via API.",
    tags: ["Messages"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE],
    parameters: [workspaceIdParam, messageIdParam],
    requestSchema: updateMessageSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(messageSchema),
    canReturn404: true,
  },
  {
    method: "delete",
    path: "/api/v1/workspaces/{workspaceId}/messages/{messageId}",
    operationId: "deleteMessage",
    summary: "Delete a message",
    description: "Delete a message you previously sent via API.",
    tags: ["Messages"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE],
    parameters: [workspaceIdParam, messageIdParam],
    responseSchema: z.void(),
    successStatus: 204,
    canReturn404: true,
  },

  // --- Users ---
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/users",
    operationId: "listUsers",
    summary: "List workspace users",
    description: "List users in the workspace with optional text search and cursor pagination.",
    tags: ["Users"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.USERS_READ],
    parameters: [workspaceIdParam],
    requestSchema: listUsersSchema,
    requestIn: "query",
    responseSchema: paginated(userSchema),
  },

  // --- Identity ---
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/me",
    operationId: "getMe",
    summary: "Get the authenticated principal",
    description:
      "Returns a discriminated union describing the authenticated principal — either the API-key owner " +
      '(`kind: "user"`) or the bot whose key is in use (`kind: "bot"`). Used by clients (e.g. the ' +
      "OpenClaw channel plugin) to verify their key and discover their identity after pairing.",
    tags: ["Identity"],
    scopes: [],
    parameters: [workspaceIdParam],
    responseSchema: dataEnvelope(principalSchema),
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/me/bots",
    operationId: "listMyBots",
    summary: "List my personal bots",
    description:
      "For user-scoped keys: lists the authenticated user's personal bots, optionally filtered by trait. " +
      "Used by the frontend to enumerate quick-switcher commands. Bot-scoped keys receive 403.",
    tags: ["Identity"],
    scopes: [],
    parameters: [workspaceIdParam],
    requestSchema: listMyBotsSchema,
    requestIn: "query",
    responseSchema: dataArrayEnvelope(personalBotSchema),
  },
]

// Export response schemas for tests and derived wire types for serializers
export {
  streamSchema,
  messageSchema,
  searchResultSchema,
  memberSchema,
  userSchema,
  botSchema,
  principalSchema,
  memoSearchResultSchema,
  memoDetailSchema,
  attachmentSearchResultSchema,
  attachmentDetailsSchema,
  attachmentUrlSchema,
  errorSchema,
}

// Wire types derived from schemas — serializers annotate their return types with these
export type WireStream = z.infer<typeof streamSchema>
export type WireMessage = z.infer<typeof messageSchema>
export type WireSearchResult = z.infer<typeof searchResultSchema>
export type WireMember = z.infer<typeof memberSchema>
export type WireUser = z.infer<typeof userSchema>
export type WireBot = z.infer<typeof botSchema>
export type WirePrincipal = z.infer<typeof principalSchema>
export type WireMemoSearchResult = z.infer<typeof memoSearchResultSchema>
export type WireMemoDetail = z.infer<typeof memoDetailSchema>
export type WireAttachmentSearchResult = z.infer<typeof attachmentSearchResultSchema>
export type WireAttachmentDetails = z.infer<typeof attachmentDetailsSchema>
export type WireAttachmentUrl = z.infer<typeof attachmentUrlSchema>
