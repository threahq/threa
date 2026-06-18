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
  MEMORY_MODES,
  AUTHOR_TYPES,
  VISIBILITY_OPTIONS,
  LABEL_ACTOR_TYPES,
  LABELABLE_RESOURCE_TYPES,
  MEMO_TYPES,
  KNOWLEDGE_TYPES,
  PROCESSING_STATUSES,
  EXTRACTION_CONTENT_TYPES,
  THREA_CALLBACK_TOKEN_HEADER,
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
  createRuntimeSessionSchema,
  renameRuntimeSessionSchema,
  rebindRuntimeSessionSchema,
  claimInvocationSchema,
  renewInvocationClaimSchema,
  completeInvocationSchema,
  failInvocationSchema,
  recordInvocationStepSchema,
  recordSealedInvocationStepSchema,
  startSealedInvocationStepSchema,
  completeSealedInvocationSchema,
  createLabelSchema,
  updateLabelSchema,
  labelAssignmentSchema,
} from "./schemas"

// Response schemas — the single source of truth for public API wire shapes.
// Serializer return types are derived from these schemas (see WireStream etc.)
// so any drift between docs and runtime is a compile-time error.

const streamSchema = z.object({
  id: z.string(),
  type: z.enum(STREAM_TYPES),
  displayName: z.string(),
  slug: z.string().optional(),
  description: z.string().optional(),
  visibility: z.string(),
  memoryMode: z.enum(MEMORY_MODES).describe("GAM memory automation gate: 'auto' extracts memos, 'off' disables it"),
  parentStreamId: z.string().optional(),
  rootStreamId: z.string().optional(),
  parentMessageId: z.string().optional(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
})

const attachmentSummarySchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  processingStatus: z.enum(PROCESSING_STATUSES).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
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
  attachments: z.array(attachmentSummarySchema).optional(),
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

// A label and its owning/applying actor. `creatorActorType` + `creatorActorId`
// (and `actorType` + `actorId` on members/assignments) identify the actor: a
// user (the id is a UserId) or a bot (the id is a bot id). The public wire uses
// actor-explicit field names so a bot-owned label is never mistaken for a user's.
const labelSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  visibility: z.enum(VISIBILITY_OPTIONS),
  creatorActorType: z.enum(LABEL_ACTOR_TYPES),
  creatorActorId: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string(),
  emoji: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
})

const labelMemberSchema = z.object({
  labelId: z.string(),
  actorType: z.enum(LABEL_ACTOR_TYPES),
  actorId: z.string(),
  workspaceId: z.string(),
  joinedAt: z.string().datetime(),
})

const labelAssignmentResponseSchema = z.object({
  labelId: z.string(),
  resourceType: z.enum(LABELABLE_RESOURCE_TYPES),
  resourceId: z.string(),
  actorType: z.enum(LABEL_ACTOR_TYPES),
  actorId: z.string(),
  workspaceId: z.string(),
  assignedAt: z.string().datetime(),
})

// The label catalog visible to the key: all public labels plus the actor's own
// private labels, their memberships, and the assignments they can see on
// reachable resources. Mirrors the internal bootstrap bundle.
const labelCatalogSchema = z.object({
  labels: z.array(labelSchema),
  memberships: z.array(labelMemberSchema),
  assignments: z.array(labelAssignmentResponseSchema),
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

const attachmentUploadSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  processingStatus: z.enum(PROCESSING_STATUSES),
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

const externalHistoryMessageSchema = z.object({
  messageId: z.string(),
  role: z.enum(["user", "assistant"]),
  authorId: z.string(),
  authorType: z.enum(AUTHOR_TYPES),
  authorDisplayName: z.string().optional(),
  contentMarkdown: z.string(),
  createdAt: z.string().datetime(),
})

// Wire shape of `ExternalContextHandle` (@threa/agent-runtime): recent
// conversation from the invocation's own stream, oldest → newest, trigger
// excluded (it travels as `promptMarkdown`). Discriminated on `kind` so a
// fetch-back `ref` variant can be added later without a wire break; only the
// inline variant exists today.
const externalContextHandleSchema = z.object({
  kind: z.literal("inline"),
  messages: z.array(externalHistoryMessageSchema),
})

// Wire shape of `SealedTurnContext` (@threa/types): the sealed assignment handed
// to an owner-granted external runner when the delivery verdict is `sealed`. The
// backend never decrypts — it ships the SSK wraps addressed to the claiming bot's
// BIK plus the sealed history/prompt ciphertext, and the bot opens them with its
// identity private key. Mutually exclusive with `context` (a stream resolves to
// one verdict). Present only on sealed claims; the whole path is dark until the
// `externalSealedDelivery` policy switch flips.
const sealedEnvelopeSchema = z.object({
  v: z.number(),
  keyGeneration: z.number().int().min(0),
  iv: z.string(),
  aad: z.string(),
})

const sealedMessageSchema = z.object({
  ciphertext: z.string(),
  envelope: sealedEnvelopeSchema,
})

const sealedTurnContextSchema = z.object({
  callbackToken: z.string(),
  wraps: z.array(
    z.object({
      keyGeneration: z.number().int().min(0),
      wrapEnc: z.string(),
      wrapCt: z.string(),
    })
  ),
  history: z.array(
    sealedMessageSchema.extend({
      role: z.enum(["user", "assistant"]),
      sequence: z.string(),
    })
  ),
  prompt: sealedMessageSchema,
  reply: z.object({ keyGeneration: z.number().int().min(0), senderId: z.string() }),
  trigger: z
    .object({
      messageId: z.string(),
      authorName: z.string(),
      authorType: z.enum(AUTHOR_TYPES),
      createdAt: z.string().datetime(),
    })
    .optional(),
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
  claimToken: z.string(),
  claimExpiresAt: z.string().datetime(),
  runtimeSessionId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  // Omitted when context is withheld (E2E or unresolvable stream); an empty
  // conversation is an explicit `{ kind: "inline", messages: [] }` instead.
  context: externalContextHandleSchema.optional(),
  // Present instead of `context` on a sealed claim (the two are mutually
  // exclusive — a stream resolves to one delivery verdict).
  sealedContext: sealedTurnContextSchema.optional(),
})

const runtimeSessionLinkSchema = z.object({
  linkId: z.string(),
  rootStreamId: z.string(),
  activeStreamId: z.string(),
  runtimeSessionId: z.string(),
  streamUrlPath: z.string(),
})

const renamedRuntimeSessionLinkSchema = runtimeSessionLinkSchema.extend({ displayName: z.string() })

const invocationStatusSchema = z.object({ invocationId: z.string(), status: z.string() })
const invocationStepSchema = z.object({ invocationId: z.string(), sessionId: z.string(), stepId: z.string() })
const renewedInvocationSchema = invocationStatusSchema.extend({ claimExpiresAt: z.string().datetime().nullable() })
const completedInvocationSchema = z.object({ invocationId: z.string(), message: messageSchema.nullable() })
const sealedCompletedInvocationSchema = z.object({
  invocationId: z.string(),
  sessionId: z.string(),
  messageId: z.string().nullable(),
})

const errorSchema = z.object({
  error: z.string(),
  details: z.record(z.string(), z.array(z.string())).optional(),
})

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

const labelIdParam = {
  name: "labelId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Label ID (prefixed ULID)",
}

const callbackTokenHeaderParam = {
  name: THREA_CALLBACK_TOKEN_HEADER,
  in: "header" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Per-claim callback token from the sealed claim response (binds the caller to the assigned session).",
}

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
    in: "path" | "query" | "header"
    required: boolean
    schema: { type: string }
    description: string
  }>
  /** Zod schema for query parameters (GET) or request body (POST/PATCH) */
  requestSchema?: z.ZodType
  /** Where the request schema applies */
  requestIn?: "query" | "body" | "multipart"
  /** Zod schema for successful response body */
  responseSchema: z.ZodType
  /** HTTP status code for successful response */
  successStatus?: number
  /** Whether the endpoint can return 404 (resource not found) */
  canReturn404?: boolean
}

export const PUBLIC_API_ROUTES: PublicApiRoute[] = [
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
    path: "/api/v1/workspaces/{workspaceId}/attachments",
    operationId: "uploadAttachment",
    summary: "Upload an attachment",
    description:
      "Upload a file as multipart/form-data using field `file`. Include the returned attachment id in message markdown as `attachment:<id>` to attach it to a message.",
    tags: ["Attachments"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_WRITE],
    parameters: [workspaceIdParam],
    requestIn: "multipart",
    responseSchema: dataEnvelope(attachmentUploadSchema),
    successStatus: 201,
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
    path: "/api/v1/workspaces/{workspaceId}/bot-runtime/sessions",
    operationId: "createBotRuntimeSession",
    summary: "Create or link a bot runtime session",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: createRuntimeSessionSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(runtimeSessionLinkSchema),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-runtime/sessions/rename",
    operationId: "renameBotRuntimeSession",
    summary: "Rename the scratchpad linked to a bot runtime session",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: renameRuntimeSessionSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(renamedRuntimeSessionLinkSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-runtime/sessions/rebind",
    operationId: "rebindBotRuntimeSession",
    summary: "Move an existing bot runtime session link to a new runtime instance id",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: rebindRuntimeSessionSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(runtimeSessionLinkSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/claim",
    operationId: "claimBotInvocation",
    summary: "Claim one pending bot invocation",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: claimInvocationSchema,
    requestIn: "body",
    responseSchema: z.object({ data: claimedInvocationSchema.nullable() }),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/renew",
    operationId: "renewBotInvocationClaim",
    summary: "Renew a claimed bot invocation",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
    ],
    requestSchema: renewInvocationClaimSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(renewedInvocationSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/steps",
    operationId: "recordBotInvocationStep",
    summary: "Record a bot invocation trace step",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
    ],
    requestSchema: recordInvocationStepSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(invocationStepSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/sealed-steps/started",
    operationId: "startBotInvocationSealedStep",
    summary: "Open an in-flight sealed bot invocation trace step",
    description:
      "Sealed variant of the trace-step start, for an owner-granted E2E bot harness: the content is ciphertext the server never decrypts. Authenticated with the per-claim callback token in the X-Threa-Callback-Token header.",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
      callbackTokenHeaderParam,
    ],
    requestSchema: startSealedInvocationStepSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(invocationStepSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/sealed-steps",
    operationId: "recordBotInvocationSealedStep",
    summary: "Finalize a sealed bot invocation trace step",
    description:
      "Sealed variant of the trace-step finalize, for an owner-granted E2E bot harness: sets the sealed content + completion on the step opened at sealed-steps/started (or inserts a completed row if the start was dropped). Authenticated with the per-claim callback token in the X-Threa-Callback-Token header.",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
      callbackTokenHeaderParam,
    ],
    requestSchema: recordSealedInvocationStepSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(invocationStepSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/sealed-complete",
    operationId: "completeBotInvocationSealed",
    summary: "Complete a sealed bot invocation",
    description:
      "Sealed variant of the completion, for an owner-granted E2E bot harness: persists the turn's final sealed reply (ciphertext the server never decrypts) or noResponse, flips the claim, and finalizes the agent session. Authenticated with the per-claim callback token in the X-Threa-Callback-Token header.",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
      callbackTokenHeaderParam,
    ],
    requestSchema: completeSealedInvocationSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(sealedCompletedInvocationSchema),
    canReturn404: true,
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

  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/labels",
    operationId: "listLabels",
    summary: "List labels",
    description:
      "The label catalog visible to this key: all public labels plus the key actor's own private labels, " +
      "their memberships, and assignments on reachable resources.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_READ],
    parameters: [workspaceIdParam],
    responseSchema: dataEnvelope(labelCatalogSchema),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/labels",
    operationId: "createLabel",
    summary: "Create a label",
    description: "Create a label owned by the key actor (a user or a bot).",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: createLabelSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(labelSchema),
    successStatus: 201,
  },
  {
    method: "patch",
    path: "/api/v1/workspaces/{workspaceId}/labels/{labelId}",
    operationId: "updateLabel",
    summary: "Update a label",
    description: "Update a label the key actor created.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam, labelIdParam],
    requestSchema: updateLabelSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(labelSchema),
    canReturn404: true,
  },
  {
    method: "delete",
    path: "/api/v1/workspaces/{workspaceId}/labels/{labelId}",
    operationId: "deleteLabel",
    summary: "Delete a label",
    description: "Archive a label the key actor created and remove its memberships and assignments.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam, labelIdParam],
    responseSchema: z.void(),
    successStatus: 204,
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/labels/{labelId}/join",
    operationId: "joinLabel",
    summary: "Join a public label",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam, labelIdParam],
    responseSchema: dataEnvelope(labelMemberSchema),
    successStatus: 201,
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/labels/{labelId}/leave",
    operationId: "leaveLabel",
    summary: "Leave a label",
    description: "Drop the key actor's membership. The last member leaving archives the label.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam, labelIdParam],
    responseSchema: z.void(),
    successStatus: 204,
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/labels/{labelId}/promote",
    operationId: "promoteLabel",
    summary: "Promote a private label to public",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam, labelIdParam],
    responseSchema: dataEnvelope(labelSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/labels/{labelId}/assignments",
    operationId: "assignLabel",
    summary: "Apply a label to a resource",
    description:
      "Attach a label to a resource the key actor can reach. `resourceType` is the polymorphic target " +
      "(`stream` today) so the same endpoint labels any future resource without a wire change.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam, labelIdParam],
    requestSchema: labelAssignmentSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(labelAssignmentResponseSchema),
    successStatus: 201,
    canReturn404: true,
  },
  {
    method: "delete",
    path: "/api/v1/workspaces/{workspaceId}/labels/{labelId}/assignments",
    operationId: "unassignLabel",
    summary: "Remove a label from a resource",
    description: "Remove the key actor's own assignment of a label from a resource.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam, labelIdParam],
    requestSchema: labelAssignmentSchema,
    requestIn: "query",
    responseSchema: z.void(),
    successStatus: 204,
    canReturn404: true,
  },

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
  attachmentUploadSchema,
  attachmentDetailsSchema,
  attachmentUrlSchema,
  labelSchema,
  labelMemberSchema,
  labelAssignmentResponseSchema,
  labelCatalogSchema,
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
export type WireAttachmentUpload = z.infer<typeof attachmentUploadSchema>
export type WireAttachmentDetails = z.infer<typeof attachmentDetailsSchema>
export type WireAttachmentUrl = z.infer<typeof attachmentUrlSchema>
export type WireLabel = z.infer<typeof labelSchema>
export type WireLabelMember = z.infer<typeof labelMemberSchema>
export type WireLabelAssignment = z.infer<typeof labelAssignmentResponseSchema>
export type WireLabelCatalog = z.infer<typeof labelCatalogSchema>
