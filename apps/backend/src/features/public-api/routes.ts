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
  BOT_INVOCATION_CANCELLATION_REASONS,
  BOT_RUNTIME_KINDS,
  BOT_RUNTIME_STATUSES,
  BOT_TRAITS,
  CONVERSATION_STATUSES,
  WORKSPACE_PERMISSION_SCOPES,
  SHARED_SOURCE_STREAM_KINDS,
  STREAM_TYPES,
  VISIBILITY_OPTIONS,
  MEMORY_MODES,
  AUTHOR_TYPES,
  LABEL_ACTOR_TYPES,
  LABELABLE_RESOURCE_TYPES,
  MEMO_TYPES,
  KNOWLEDGE_TYPES,
  AUTHORED_BY_KINDS,
  MEMO_SCOPES,
  PROCESSING_STATUSES,
  EXTRACTION_CONTENT_TYPES,
  THREA_CALLBACK_TOKEN_HEADER,
  DELEGATION_STATUSES,
} from "@threa/types"
import type { WorkspacePermissionSlug } from "@threa/types"
import {
  publicSearchSchema,
  listMyBotsSchema,
  listStreamsSchema,
  listMessagesSchema,
  listConversationsSchema,
  listConversationMessagesSchema,
  sendMessageSchema,
  updateMessageSchema,
  updateStreamSchema,
  listMembersSchema,
  listUsersSchema,
  searchMemosSchema,
  searchAttachmentsSchema,
  findMessagesByMetadataSchema,
  upsertPresenceSchema,
  createRuntimeSessionSchema,
  provisionSessionKeyWrapsSchema,
  renameRuntimeSessionSchema,
  rebindRuntimeSessionSchema,
  endRuntimeSessionSchema,
  briefRuntimeSessionSchema,
  claimInvocationSchema,
  renewInvocationClaimSchema,
  completeInvocationSchema,
  failInvocationSchema,
  recordInvocationStepSchema,
  recordSealedInvocationStepSchema,
  startSealedInvocationStepSchema,
  sendInvocationMessageSchema,
  sendSealedInvocationMessageSchema,
  completeSealedInvocationSchema,
  createLabelSchema,
  updateLabelSchema,
  assignLabelByNameSchema,
  unassignLabelByNameSchema,
  listDelegationsQuerySchema,
  claimDelegationSchema,
  reportDelegationStatusSchema,
  completeDelegationSchema,
  failDelegationSchema,
  requestDelegationAccessSchema,
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
  anchorId: z
    .string()
    .optional()
    .describe(
      "Canonical id of the timeline item a thread anchors on. The prefix is the kind: 'msg_…' for a message, 'event_…' for a card. Present on threads only."
    ),
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
  revision: z.number().int().positive().describe("1 for the original body, +1 per edit"),
  editedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
})

// A conversation: a first-class grouping of messages under one effective root
// stream (the root plus any of its threads). Membership is curated by declared
// send directives and the async boundary extractor.
const conversationSchema = z.object({
  id: z.string(),
  streamId: z.string().describe("Anchor stream the conversation lives in (may be a thread)"),
  rootStreamId: z.string().describe("Effective root of the anchor — the stream whose access governs the conversation"),
  topicSummary: z.string().nullable(),
  summary: z.string().nullable(),
  status: z.enum(CONVERSATION_STATUSES),
  messageCount: z.number().int().describe("Number of primary member messages"),
  participantIds: z.array(z.string()).describe("Distinct author ids of the member messages"),
  lastActivityAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

// A hydrated slot value in a response-level `slots` map. Discriminated by
// `state`; `type` is the forward-compatible slot-kind discriminator (the
// shared-message slot is the only kind today). The `ok` variant exposes the
// source as markdown `content` — never `contentJson` (INV-58) — plus the
// author/source/date/attachment metadata a custom pointer link renders from.
// The other states are the privacy-safe placeholders: `private` reveals only
// the source stream's kind + visibility, never content/author/name.
const contentRangeSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
})

const sharedMessageSlotSchema = z.discriminatedUnion("state", [
  z.object({
    type: z.literal("sharedMessage"),
    state: z.literal("ok"),
    messageId: z.string(),
    streamId: z.string(),
    authorId: z.string(),
    authorType: z.enum(AUTHOR_TYPES),
    authorDisplayName: z.string().optional(),
    content: z
      .string()
      .describe(
        "The pinned source content as markdown — the revision and span the pointer names, not the source as it reads now. The canonical rich-text JSON stays internal."
      ),
    version: z.number().int().positive().describe("The source revision this slot renders."),
    currentRevision: z
      .number()
      .int()
      .positive()
      .describe(
        "The source's current revision; greater than `version` once the source was edited after the reference was made."
      ),
    range: contentRangeSchema
      .nullable()
      .describe("The referenced span of the revision, or null for the whole message."),
    editedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    attachments: z.array(attachmentSummarySchema).describe("Source attachments; empty when the slot renders a span."),
  }),
  z.object({
    type: z.literal("sharedMessage"),
    state: z.literal("deleted"),
    messageId: z.string(),
    deletedAt: z.string().datetime(),
  }),
  z.object({ type: z.literal("sharedMessage"), state: z.literal("missing"), messageId: z.string() }),
  z.object({
    type: z.literal("sharedMessage"),
    state: z.literal("private"),
    messageId: z.string(),
    sourceStreamKind: z.enum(SHARED_SOURCE_STREAM_KINDS),
    sourceVisibility: z.enum(VISIBILITY_OPTIONS),
  }),
  z.object({
    type: z.literal("sharedMessage"),
    state: z.literal("truncated"),
    messageId: z.string(),
    streamId: z.string(),
  }),
])

// Response-level slot envelope: namespaced key (`shared:<messageId>`) → slot.
// One map per response dedupes repeated/nested source references across all
// returned messages. Present (possibly empty) on every operation that returns
// renderable message markdown.
const slotMapSchema = z
  .record(z.string(), sharedMessageSlotSchema)
  .describe(
    "Hydration for shared-message pointers in the returned messages, keyed by the pointer's reference: `shared:<messageId>` (legacy, current revision), `shared:<messageId>@<version>` (pinned revision) or `shared:<messageId>@<version>:<from>-<to>` (pinned span). Always present; empty when no message references a shared source."
  )

const sendMessageResponseSchema = z.object({
  data: messageSchema,
  conversationId: z
    .string()
    .optional()
    .describe("The conversation the message was assigned to; present when the request declared a `conversation`."),
  slots: slotMapSchema,
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

// A label and its owning actor. `creatorActorType` + `creatorActorId` (and
// `actorType` + `actorId` on assignments) identify the actor: a user (the id is
// a UserId) or a bot (the id is a bot id). The public wire uses actor-explicit
// field names so a bot-owned label is never mistaken for a user's.
const labelSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
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

const labelAssignmentResponseSchema = z.object({
  labelId: z.string(),
  resourceType: z.enum(LABELABLE_RESOURCE_TYPES),
  resourceId: z.string(),
  actorType: z.enum(LABEL_ACTOR_TYPES),
  actorId: z.string(),
  workspaceId: z.string(),
  assignedAt: z.string().datetime(),
})

// The key actor's label catalog: their own labels plus the assignments they can
// see on reachable resources. Mirrors the internal bootstrap bundle.
const labelCatalogSchema = z.object({
  labels: z.array(labelSchema),
  assignments: z.array(labelAssignmentResponseSchema),
})

// The result of applying a label by name: the resolved (found-or-created) label
// and the assignment that attached it.
const labelAssignmentResultSchema = z.object({
  label: labelSchema,
  assignment: labelAssignmentResponseSchema,
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
  readsAsOwner: z.literal(false),
})

const personalBotSchema = z.object({
  ...botCommonFields,
  type: z.literal("personal"),
  ownerUserId: z.string(),
  readsAsOwner: z.boolean(),
})

const botSchema = z.discriminatedUnion("type", [sharedBotSchema, personalBotSchema])

// Principal can't use a single-discriminator union because the bot variants
// share `kind: "bot"` but split on `botType`. z.union handles the three-way
// shape correctly; the generated OpenAPI uses `oneOf`, which clients narrow
// on `kind` first and then `botType` for the bot branch.
const apiVersionInfoSchema = z.object({
  pinned: z
    .string()
    .nullable()
    .describe("The key's pinned version, or null when the key is unpinned and tracks the current version"),
  resolved: z.string().describe("Version this request resolved to (header override, else pin, else current)"),
  current: z.string().describe("The latest API version"),
  supported: z.array(z.string()).describe("All versions the API currently accepts"),
})

const principalSchema = z.union([
  z.object({
    kind: z.literal("user"),
    workspaceId: z.string(),
    userId: z.string(),
    apiVersion: apiVersionInfoSchema,
  }),
  z.object({
    kind: z.literal("bot"),
    workspaceId: z.string(),
    botId: z.string(),
    botType: z.literal("shared"),
    traits: z.array(z.enum(BOT_TRAITS)),
    ownerUserId: z.null(),
    apiVersion: apiVersionInfoSchema,
  }),
  z.object({
    kind: z.literal("bot"),
    workspaceId: z.string(),
    botId: z.string(),
    botType: z.literal("personal"),
    traits: z.array(z.enum(BOT_TRAITS)),
    ownerUserId: z.string(),
    apiVersion: apiVersionInfoSchema,
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
  authoredByKind: z.enum(AUTHORED_BY_KINDS),
  sourceSessionId: z.string().nullable(),
  scope: z.enum(MEMO_SCOPES),
  scopeUserId: z.string().nullable(),
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
  successorMemoId: z.string().nullable(),
  capturedByPersonaName: z.string().nullable(),
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

const sealedWrapSchema = z.object({
  keyGeneration: z.number().int().min(0),
  wrapEnc: z.string(),
  wrapCt: z.string(),
})

const sealedTurnContextSchema = z.object({
  callbackToken: z.string(),
  wraps: z.array(sealedWrapSchema),
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
  sourceRevision: z.number().int().min(0),
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
  // The linked scratchpad's encryption state — set on create (echoes the e2e
  // request) and on resume (the existing stream's actual state).
  e2eEnabled: z.boolean().optional(),
})
const ownerE2eKeySchema = z.object({ keyId: z.string(), publicKey: z.string() })
const provisionedWrapsSchema = z.object({ stored: z.number().int() })

const renamedRuntimeSessionLinkSchema = runtimeSessionLinkSchema.extend({ displayName: z.string() })

const endedRuntimeSessionLinkSchema = z.object({
  linkId: z.string(),
  rootStreamId: z.string(),
  activeStreamId: z.string(),
  status: z.literal("ended"),
})

const briefedRuntimeSessionSchema = z.object({
  invocationId: z.string(),
  streamId: z.string(),
})

const delegationSchema = z.object({
  id: z.string(),
  streamId: z.string(),
  title: z.string(),
  status: z.enum(DELEGATION_STATUSES),
  claimedByLabel: z.string().optional(),
  statusNote: z.string().optional(),
  resultMessageId: z.string().optional(),
  sourceConversationId: z.string().optional(),
  createdAt: z.string().datetime(),
  statusChangedAt: z.string().datetime(),
})

const inspectedDelegationSchema = delegationSchema.extend({
  brief: z.string(),
  contextRefs: z.array(z.string()),
  claimExpiresAt: z.string().datetime().optional(),
})

const claimedDelegationSchema = delegationSchema.extend({
  /** The complete hand-off prompt (markdown) — the executor's working set. */
  brief: z.string(),
  /** Pointer URLs (`shared-message:`/`memo:`/`attachment:`) backing the brief. */
  contextRefs: z.array(z.string()),
  /** Cleartext claim token, returned exactly once. Send it as X-Threa-Callback-Token on every later call. */
  claimToken: z.string(),
  claimExpiresAt: z.string().datetime(),
})

const delegationHeartbeatSchema = z.object({ claimExpiresAt: z.string().datetime() })

const completedDelegationSchema = delegationSchema.extend({
  resultMessageId: z.string().optional(),
  /** Thread containing the full result, for both legacy anchor and card-anchor completions. */
  resultThreadId: z.string().optional(),
})

const delegationAccessRequestSchema = z.object({
  /** Absent when the bot already had access (`already_granted`); otherwise the open request's id. */
  requestId: z.string().optional(),
  /** `already_granted` (no card filed) or `open` (a request card exists in the stream). */
  status: z.string(),
})

const invocationStatusSchema = z.object({ invocationId: z.string(), status: z.string() })
const invocationStepSchema = z.object({ invocationId: z.string(), sessionId: z.string(), stepId: z.string() })
const invocationUpdateSchema = z.discriminatedUnion("delivery", [
  z.object({
    delivery: z.literal("plaintext"),
    sourceRevision: z.number().int().min(0),
    promptMarkdown: z.string(),
    mentionedActorSlugs: z.array(z.string()),
  }),
  z.object({
    delivery: z.literal("sealed"),
    sourceRevision: z.number().int().min(0),
    prompt: sealedMessageSchema,
    wraps: z.array(sealedWrapSchema),
    reply: z.object({ keyGeneration: z.number().int().min(0), senderId: z.string() }),
  }),
])
const renewedInvocationSchema = z.discriminatedUnion("status", [
  z.object({
    invocationId: z.string(),
    status: z.literal("active"),
    claimExpiresAt: z.string().datetime(),
    sourceRevision: z.number().int().min(0),
    update: invocationUpdateSchema.optional(),
  }),
  z.object({
    invocationId: z.string(),
    status: z.literal("cancelled"),
    claimExpiresAt: z.null(),
    sourceRevision: z.number().int().min(0),
    reason: z.enum(BOT_INVOCATION_CANCELLATION_REASONS),
  }),
])
const completedInvocationSchema = z.object({ invocationId: z.string(), message: messageSchema.nullable() })
const sealedCompletedInvocationSchema = z.object({
  invocationId: z.string(),
  sessionId: z.string(),
  messageId: z.string().nullable(),
})
const sealedMessageResultSchema = z.object({ messageId: z.string() })
const invocationMessageSchema = z.object({ invocationId: z.string(), sessionId: z.string(), messageId: z.string() })

const errorSchema = z.object({
  error: z.string(),
  code: z.string().optional().describe("Machine-readable error code, e.g. INVALID_API_VERSION"),
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

const conversationIdParam = {
  name: "conversationId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Conversation ID (prefixed ULID)",
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

const delegationIdParam = {
  name: "delegationId",
  in: "path" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Delegation ID (prefixed ULID)",
}

const delegationTokenHeaderParam = {
  name: THREA_CALLBACK_TOKEN_HEADER,
  in: "header" as const,
  required: true,
  schema: { type: "string" as const },
  description: "Per-claim token from the delegation claim response (binds the caller to its claim).",
}

export type OperationId =
  | "searchMessages"
  | "searchMemos"
  | "getMemo"
  | "uploadAttachment"
  | "searchAttachments"
  | "getAttachment"
  | "getAttachmentDownloadUrl"
  | "upsertBotRuntimePresence"
  | "createBotRuntimeSession"
  | "getBotOwnerE2eKey"
  | "provisionStreamE2eKeyWraps"
  | "renameBotRuntimeSession"
  | "rebindBotRuntimeSession"
  | "endBotRuntimeSession"
  | "briefBotRuntimeSession"
  | "claimBotInvocation"
  | "renewBotInvocationClaim"
  | "recordBotInvocationStep"
  | "startBotInvocationSealedStep"
  | "recordBotInvocationSealedStep"
  | "sendBotInvocationMessage"
  | "sendBotInvocationSealedMessage"
  | "completeBotInvocationSealed"
  | "completeBotInvocation"
  | "failBotInvocation"
  | "listDelegations"
  | "getDelegation"
  | "claimDelegation"
  | "releaseDelegation"
  | "heartbeatDelegation"
  | "reportDelegationStatus"
  | "completeDelegation"
  | "failDelegation"
  | "requestDelegationAccess"
  | "listStreams"
  | "getStream"
  | "updateStream"
  | "listMembers"
  | "listMessages"
  | "sendMessage"
  | "listConversations"
  | "getConversation"
  | "listConversationMessages"
  | "findMessagesByMetadata"
  | "updateMessage"
  | "deleteMessage"
  | "listUsers"
  | "listLabels"
  | "createLabel"
  | "assignLabel"
  | "unassignLabel"
  | "updateLabel"
  | "deleteLabel"
  | "getMe"
  | "listMyBots"

export interface PublicApiRoute {
  method: "get" | "post" | "patch" | "delete"
  path: string
  operationId: OperationId
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
  /** Whether the endpoint can return 409 (resource not in the required state) */
  canReturn409?: boolean
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
    responseSchema: dataArrayEnvelope(searchResultSchema).extend({ slots: slotMapSchema }),
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
    description:
      "Search accessible attachments by filename or extracted content. Omit query to browse the most recent attachments.",
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
    description:
      "Creates a fresh scratchpad session by default. Pass `attachTo` to link the session to a new thread under an existing scratchpad the bot already has access to instead. An identity that is already linked resumes its existing link in either mode; compare the returned `rootStreamId` and `activeStreamId` with the request to tell the two apart.",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: createRuntimeSessionSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(runtimeSessionLinkSchema),
    canReturn404: true,
    canReturn409: true,
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/bot-runtime/owner-e2e-key",
    operationId: "getBotOwnerE2eKey",
    summary: "Get the bot owner's active encryption public key",
    description:
      "The bot owner's active UIK (key id + base64 X25519 public key). A sealed harness fetches this before creating an end-to-end-encrypted session so it can wrap the generation-0 stream key to the owner. 404 when the owner has not set up encryption.",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [workspaceIdParam],
    responseSchema: dataEnvelope(ownerE2eKeySchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}/e2e/key-wraps",
    operationId: "provisionStreamE2eKeyWraps",
    summary: "Provision the generation-0 key wraps for a harness-created encrypted scratchpad",
    description:
      "Phase two of harness-created E2E scratchpads: stores the stream-key wraps (owner UIK + the harness's own BIK) minted against the stream id returned by session create. Bot-actor-only, current generation only, and only while the generation has no wraps. Slots are immutable, so a replay cannot splice keys.",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "streamId", in: "path", required: true, schema: { type: "string" }, description: "Stream ID" },
    ],
    requestSchema: provisionSessionKeyWrapsSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(provisionedWrapsSchema),
    canReturn404: true,
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
    path: "/api/v1/workspaces/{workspaceId}/bot-runtime/sessions/end",
    operationId: "endBotRuntimeSession",
    summary: "End the runtime session link on purpose",
    description:
      "Ends the link without archiving its scratchpad and frees the runtime identity for reuse. Cancels any pending invocation still routed at this runtime session.",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: endRuntimeSessionSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(endedRuntimeSessionLinkSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-runtime/sessions/brief",
    operationId: "briefBotRuntimeSession",
    summary: "Brief the linked runtime session with a prompt",
    description:
      "Creates the invocation that delivers a prompt as a turn to the linked runtime session. The turn is sourced from the thread's anchor message and answered into the thread, so the brief writes no message of its own.",
    tags: ["Bot runtimes"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: briefRuntimeSessionSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(briefedRuntimeSessionSchema),
    canReturn404: true,
    successStatus: 201,
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
    canReturn409: true,
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
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/messages",
    operationId: "sendBotInvocationMessage",
    summary: "Post a message from a bot invocation",
    description:
      "Posts one plaintext message into the invocation's own response stream — progress notes and permission prompts mid-turn, follow-ups after the turn completed (a claim-bound completed invocation may still post; completion itself stays terminal and is never reopened). The claim decides the stream and the session the message is attributed to, so a harness never has to name either. Rejects end-to-end encrypted streams (use sealed-messages). Authenticated with the bot API key plus the claim's instanceId and claimToken; clientMessageId dedupes a retried post.",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
    ],
    requestSchema: sendInvocationMessageSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(invocationMessageSchema),
    canReturn404: true,
    canReturn409: true,
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
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/sealed-messages",
    operationId: "sendBotInvocationSealedMessage",
    summary: "Post a sealed message from a sealed bot invocation",
    description:
      "Sealed variant of a bot message, for an owner-granted E2E bot harness: posts one sealed message (ciphertext the server never decrypts) into the claim's stream. Mid-turn that is a progress note, permission prompt, or early ack; after the turn completed it is a follow-up, which a callback-token-bound completed invocation may still post — completion itself stays terminal and is never reopened. The client-minted messageId binds the seal AAD and dedupes retries. Authenticated with the per-claim callback token in the X-Threa-Callback-Token header.",
    tags: ["Bot invocations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE],
    parameters: [
      workspaceIdParam,
      { name: "invocationId", in: "path", required: true, schema: { type: "string" }, description: "Invocation ID" },
      callbackTokenHeaderParam,
    ],
    requestSchema: sendSealedInvocationMessageSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(sealedMessageResultSchema),
    canReturn404: true,
    canReturn409: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/bot-invocations/{invocationId}/sealed-complete",
    operationId: "completeBotInvocationSealed",
    summary: "Complete a sealed bot invocation",
    description:
      "Sealed variant of the completion, for an owner-granted E2E bot harness: persists the turn's final sealed reply (ciphertext the server never decrypts) or noResponse, flips the claim, and finalizes the agent session. A still-active claim may recover a session marked failed by orphan cleanup. Authenticated with the per-claim callback token in the X-Threa-Callback-Token header.",
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
    canReturn409: true,
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
    responseSchema: dataEnvelope(completedInvocationSchema).extend({ slots: slotMapSchema }),
    canReturn404: true,
    canReturn409: true,
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
    path: "/api/v1/workspaces/{workspaceId}/delegations",
    operationId: "listDelegations",
    summary: "List open delegations",
    description:
      "List accessible delegations with status `open`. When `since` is provided, filters by `statusChangedAt`; returns newly created and reopened tasks whose availability changed after that instant.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_READ],
    parameters: [workspaceIdParam],
    requestSchema: listDelegationsQuerySchema,
    requestIn: "query",
    responseSchema: dataArrayEnvelope(delegationSchema),
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/delegations/{delegationId}",
    operationId: "getDelegation",
    summary: "Get a delegation",
    description:
      "Inspect an accessible delegation before claiming it. Returns its brief, context references, status, and current claim expiry, but never a claim token or other claim secret.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_READ],
    parameters: [workspaceIdParam, delegationIdParam],
    responseSchema: dataEnvelope(inspectedDelegationSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/delegations/{delegationId}/claim",
    operationId: "claimDelegation",
    summary: "Claim an open or expired delegation",
    description:
      "Atomically claim an open delegation or a historical delegation still stored as `expired`. A matching idempotency key can re-key only the current unexpired claimed or running claim. Returns the brief, context references, and a cleartext claim token exactly once; send the token as X-Threa-Callback-Token on later lifecycle calls. Other non-open states return 409; a missing or inaccessible delegation returns 404.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_WRITE],
    parameters: [workspaceIdParam, delegationIdParam],
    requestSchema: claimDelegationSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(claimedDelegationSchema),
    canReturn404: true,
    canReturn409: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/delegations/{delegationId}/release",
    operationId: "releaseDelegation",
    summary: "Release a delegation claim",
    description:
      "Release an unexpired claimed or running delegation back to the open queue. Requires the per-claim token in X-Threa-Callback-Token. A missing, inaccessible, lapsed, stale, or replaced claim returns 404 without revealing which condition applied.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_WRITE],
    parameters: [workspaceIdParam, delegationIdParam, delegationTokenHeaderParam],
    responseSchema: dataEnvelope(delegationSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/delegations/{delegationId}/heartbeat",
    operationId: "heartbeatDelegation",
    summary: "Renew a delegation claim",
    description:
      "Renew a live claim without changing the card status. Any HTTP client can call this endpoint directly while working; send the per-claim token in X-Threa-Callback-Token.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_WRITE],
    parameters: [workspaceIdParam, delegationIdParam, delegationTokenHeaderParam],
    responseSchema: dataEnvelope(delegationHeartbeatSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/delegations/{delegationId}/status",
    operationId: "reportDelegationStatus",
    summary: "Report delegation progress",
    description:
      "Mark the delegation running and put a free-text progress note on its card (each report replaces the previous note; the claim TTL renews). Authenticated with the per-claim token in the X-Threa-Callback-Token header.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_WRITE],
    parameters: [workspaceIdParam, delegationIdParam, delegationTokenHeaderParam],
    requestSchema: reportDelegationStatusSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(delegationSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/delegations/{delegationId}/complete",
    operationId: "completeDelegation",
    summary: "Complete a delegation",
    description:
      "Complete the claimed delegation. When `resultMarkdown` is provided, the result is posted as a reply in the thread anchored on the delegation card, in the same transaction as the completion; it is authored as the key's user (with via-API provenance) for a user-scoped key, or as the bot for a workspace key. The response then includes `resultMessageId` and `resultThreadId`, and the result enters the normal message pipeline so workspace memory can capture it. Without `resultMarkdown`, the response contains only the delegation summary and no result ids. Send the per-claim token in X-Threa-Callback-Token.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_WRITE],
    parameters: [workspaceIdParam, delegationIdParam, delegationTokenHeaderParam],
    requestSchema: completeDelegationSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(completedDelegationSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/delegations/{delegationId}/fail",
    operationId: "failDelegation",
    summary: "Fail a delegation",
    description:
      "Mark the claimed delegation failed, recording why on its card. Authenticated with the per-claim token in the X-Threa-Callback-Token header.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_WRITE],
    parameters: [workspaceIdParam, delegationIdParam, delegationTokenHeaderParam],
    requestSchema: failDelegationSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(delegationSchema),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/delegations/{delegationId}/request-access",
    operationId: "requestDelegationAccess",
    summary: "Request access to a delegation's stream",
    description:
      "For a workspace (bot) key that received the delegation:available nudge but cannot claim it (no channel grant): file an access request that renders as a card in the delegation's stream for a member to approve or deny. Returns already_granted (no card) when the bot already has access; otherwise the request is idempotent per (bot, stream). 404 for an unknown delegation id — the existence-hiding carve-out is scoped to ids the workspace bot plane already saw on the nudge. A user-scoped key gets 400 (USER_KEY_CANNOT_REQUEST_ACCESS): a user key's access follows its user, who should join the stream directly.",
    tags: ["Delegations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.DELEGATIONS_WRITE],
    parameters: [workspaceIdParam, delegationIdParam],
    requestSchema: requestDelegationAccessSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(delegationAccessRequestSchema),
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
    method: "patch",
    path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}",
    operationId: "updateStream",
    summary: "Set a stream's description",
    description:
      "Set the stream's description from markdown (parsed to rich text, same as message content). Send an empty string to clear it. User-scoped keys attribute the change to the key owner; workspace-scoped keys to the bot.",
    tags: ["Streams"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.STREAMS_WRITE],
    parameters: [workspaceIdParam, streamIdParam],
    requestSchema: updateStreamSchema,
    requestIn: "body",
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
      slots: slotMapSchema,
    }),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}/messages",
    operationId: "sendMessage",
    summary: "Send a message",
    description:
      "Send a message. Workspace-scoped keys send as a bot; user-scoped keys send on behalf of the key owner. " +
      'Optionally declare the message\'s conversation via `conversation`: `{intent: "new"}` starts a fresh ' +
      'conversation, `{intent: "existing", conversationId}` posts into one under the same root stream.',
    tags: ["Messages"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE],
    parameters: [workspaceIdParam, streamIdParam],
    requestSchema: sendMessageSchema,
    requestIn: "body",
    responseSchema: sendMessageResponseSchema,
    successStatus: 201,
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/conversations",
    operationId: "listConversations",
    summary: "List conversations",
    description:
      "Cursor-paginated conversation feed across accessible streams, newest activity first. " +
      "Filter with `streamId` (scopes to that stream's root and its threads) and `status`.",
    tags: ["Conversations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
    parameters: [workspaceIdParam],
    requestSchema: listConversationsSchema,
    requestIn: "query",
    responseSchema: paginated(conversationSchema),
    canReturn404: true,
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}",
    operationId: "getConversation",
    summary: "Get a conversation",
    tags: ["Conversations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
    parameters: [workspaceIdParam, conversationIdParam],
    responseSchema: dataEnvelope(conversationSchema),
    canReturn404: true,
  },
  {
    method: "get",
    path: "/api/v1/workspaces/{workspaceId}/conversations/{conversationId}/messages",
    operationId: "listConversationMessages",
    summary: "List a conversation's messages",
    description:
      "The conversation's member messages in chronological order, cursor-paginated. Messages can span the " +
      "conversation's root stream and its threads; each message carries its own `streamId`.",
    tags: ["Conversations"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
    parameters: [workspaceIdParam, conversationIdParam],
    requestSchema: listConversationMessagesSchema,
    requestIn: "query",
    responseSchema: paginated(messageSchema).extend({ slots: slotMapSchema }),
    canReturn404: true,
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/messages/find-by-metadata",
    operationId: "findMessagesByMetadata",
    summary: "Find messages by metadata",
    description:
      "Find non-deleted messages whose `metadata` contains all the given key/value pairs (AND-containment). " +
      "Useful for dedup flows, e.g. 'has a message already been posted for this GitHub PR event?'.",
    tags: ["Messages"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ],
    parameters: [workspaceIdParam],
    requestSchema: findMessagesByMetadataSchema,
    requestIn: "body",
    responseSchema: dataArrayEnvelope(messageSchema).extend({ slots: slotMapSchema }),
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
    responseSchema: dataEnvelope(messageSchema).extend({ slots: slotMapSchema }),
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
    description: "The key actor's labels (every label is private to its owner) and their resource assignments.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_READ],
    parameters: [workspaceIdParam],
    responseSchema: dataEnvelope(labelCatalogSchema),
  },
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/labels",
    operationId: "createLabel",
    summary: "Create or update a label by name",
    description:
      "Find-or-create a label owned by the key actor (a user or a bot), keyed by its name. Posting an " +
      "existing name returns that label and applies any appearance fields supplied; labels are identified " +
      "by their text, so this is idempotent.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: createLabelSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(labelSchema),
    successStatus: 201,
  },
  // Literal `assignments` routes precede the `/{labelId}` CRUD entries below:
  // registry order is mount order, so a `:labelId` param route registered first
  // would capture `assignments` as an id.
  {
    method: "post",
    path: "/api/v1/workspaces/{workspaceId}/labels/assignments",
    operationId: "assignLabel",
    summary: "Apply a label to a resource by name",
    description:
      "Attach a label to a resource the key actor can reach, identifying the label by its text: the label " +
      "is found-or-created for the actor, then assigned. `resourceType` is the polymorphic target (`stream` " +
      "today) so the same endpoint labels any future resource without a wire change.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: assignLabelByNameSchema,
    requestIn: "body",
    responseSchema: dataEnvelope(labelAssignmentResultSchema),
    successStatus: 201,
    canReturn404: true,
  },
  {
    method: "delete",
    path: "/api/v1/workspaces/{workspaceId}/labels/assignments",
    operationId: "unassignLabel",
    summary: "Remove a label from a resource by name",
    description: "Remove the key actor's assignment of a label (identified by its text) from a resource.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam],
    requestSchema: unassignLabelByNameSchema,
    requestIn: "query",
    responseSchema: z.void(),
    successStatus: 204,
    canReturn404: true,
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
    description: "Archive a label the key actor created and remove its assignments.",
    tags: ["Labels"],
    scopes: [WORKSPACE_PERMISSION_SCOPES.LABELS_WRITE],
    parameters: [workspaceIdParam, labelIdParam],
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
      "Returns a discriminated union describing the authenticated principal: the API-key owner " +
      '(`kind: "user"`) or the bot whose key is in use (`kind: "bot"`). Also reports the key\'s API version ' +
      "pin, the version this request resolved to, and the supported versions. Used by clients (e.g. the " +
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
  conversationSchema,
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
  labelAssignmentResponseSchema,
  labelAssignmentResultSchema,
  labelCatalogSchema,
  errorSchema,
}

// Wire types derived from schemas — serializers annotate their return types with these
export type WireStream = z.infer<typeof streamSchema>
export type WireMessage = z.infer<typeof messageSchema>
export type WireSharedMessageSlot = z.infer<typeof sharedMessageSlotSchema>
export type WireSlotMap = z.infer<typeof slotMapSchema>
export type WireConversation = z.infer<typeof conversationSchema>
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
export type WireLabelAssignment = z.infer<typeof labelAssignmentResponseSchema>
export type WireLabelCatalog = z.infer<typeof labelCatalogSchema>
