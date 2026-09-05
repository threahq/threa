/**
 * Request validation schemas for the public API.
 *
 * Shared by handlers (runtime validation) and routes (doc generation).
 * Extracted to its own file to avoid a circular dependency between
 * handlers.ts and routes.ts.
 */
import { z } from "zod"
// Deep import: the bot-runtimes barrel imports public-api, so the barrel would form a cycle here.
import { botRuntimeManifestSchema } from "../bot-runtimes/manifest-schema"
import {
  BOT_INVOCATION_CAPABILITIES,
  BOT_RUNTIME_KINDS,
  BOT_RUNTIME_STATUSES,
  BOT_TRAITS,
  CONVERSATION_STATUSES,
  STREAM_TYPES,
  MEMORY_MODES,
  MEMO_TYPES,
  MEMO_SCOPES,
  KNOWLEDGE_TYPES,
  EXTRACTION_CONTENT_TYPES,
  AGENT_STEP_TYPES,
  SOURCE_TYPES,
  LABELABLE_RESOURCE_TYPES,
  STREAM_DESCRIPTION_MAX_MARKDOWN_LENGTH,
} from "@threa/types"
import { messageMetadataSchema, messageMetadataFilterSchema } from "../messaging"
import { botIdentityKeyFields, bothOrNeitherBotIdentityKey } from "../../lib/schemas"

const PUBLIC_SEARCH_MAX_LIMIT = 50
const PUBLIC_ATTACHMENT_SEARCH_MAX_LIMIT = 50
const PUBLIC_MEMO_SEARCH_MAX_LIMIT = 100

export const publicSearchSchema = z.object({
  query: z.string().min(1, "query is required"),
  semantic: z.boolean().optional().default(false),
  exact: z.boolean().optional().default(false),
  streams: z.array(z.string()).optional(),
  from: z.string().optional(),
  type: z.array(z.enum(STREAM_TYPES)).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(PUBLIC_SEARCH_MAX_LIMIT).optional().default(20),
})

export const searchMemosSchema = z.object({
  query: z.string().optional().default(""),
  exact: z.boolean().optional(),
  streams: z.array(z.string()).optional(),
  memoType: z.array(z.enum(MEMO_TYPES)).optional(),
  knowledgeType: z.array(z.enum(KNOWLEDGE_TYPES)).optional(),
  tags: z.array(z.string()).optional(),
  scope: z.enum(MEMO_SCOPES).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(PUBLIC_MEMO_SEARCH_MAX_LIMIT).optional().default(20),
})

export const searchAttachmentsSchema = z.object({
  query: z.string().min(1).optional(),
  streams: z.array(z.string()).optional(),
  contentTypes: z.array(z.enum(EXTRACTION_CONTENT_TYPES)).optional(),
  limit: z.coerce.number().int().min(1).max(PUBLIC_ATTACHMENT_SEARCH_MAX_LIMIT).optional().default(20),
})

export const listStreamsSchema = z.object({
  type: z
    .union([z.enum(STREAM_TYPES), z.array(z.enum(STREAM_TYPES))])
    .optional()
    .transform((v) => (typeof v === "string" ? [v] : v)),
  query: z.string().optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  // Query-string boolean: only the literal "true" opts in (no transform — the
  // OpenAPI generator cannot derive a schema through effects).
  includeArchived: z.enum(["true", "false"]).optional(),
})

const LABEL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

// Create-or-update a label by name. Labels are owned per actor and keyed by
// their text, so this is idempotent: posting an existing name returns that
// label, applying any appearance fields provided. `color` is optional — the
// server picks a default for a brand-new label.
export const createLabelSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(LABEL_COLOR_PATTERN, "color must be a #RRGGBB hex string").optional(),
  emoji: z.string().max(32).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
})

export const updateLabelSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    color: z.string().regex(LABEL_COLOR_PATTERN, "color must be a #RRGGBB hex string").optional(),
    emoji: z.string().max(32).nullable().optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .refine(
    (d) => d.name !== undefined || d.color !== undefined || d.emoji !== undefined || d.description !== undefined,
    {
      message: "At least one field must be provided",
    }
  )

export const labelIdParamSchema = z.object({
  labelId: z.string().min(1).max(64),
})

// Apply a label to a resource by its text. The label is found-or-created for the
// key actor (appearance fields apply on create / when given), then attached.
// `resourceType` is the polymorphic target ("stream" today) so the API isn't
// stream-specific.
export const assignLabelByNameSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(LABEL_COLOR_PATTERN, "color must be a #RRGGBB hex string").optional(),
  emoji: z.string().max(32).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  resourceType: z.enum(LABELABLE_RESOURCE_TYPES),
  resourceId: z.string().min(1).max(64),
})

// Remove a label from a resource by its text.
export const unassignLabelByNameSchema = z.object({
  name: z.string().min(1).max(100),
  resourceType: z.enum(LABELABLE_RESOURCE_TYPES),
  resourceId: z.string().min(1).max(64),
})

export const upsertPresenceSchema = z
  .object({
    runtimeKind: z.enum(BOT_RUNTIME_KINDS),
    instanceId: z.string().min(1).max(128),
    runtimeSessionId: z.string().min(1).max(256).optional(),
    displayName: z.string().max(100).optional(),
    status: z.enum(BOT_RUNTIME_STATUSES),
    acceptingInvocations: z.boolean(),
    capabilities: z.record(z.string(), z.unknown()).optional().default({}),
    manifest: botRuntimeManifestSchema.nullable().optional(),
    statusText: z.string().max(200).optional(),
    ...botIdentityKeyFields,
  })
  .refine(bothOrNeitherBotIdentityKey, {
    message: "publicKey and publicKeyId must be provided together",
    path: ["publicKey"],
  })

export const createRuntimeSessionSchema = z
  .object({
    // The runtime kinds that may own a scratchpad (see runtime-kind-config):
    // Pi and the Claude Code channel require a link, `custom` may take one.
    // The remaining kinds dispatch untargeted and never create a link, so they
    // have no business calling this endpoint.
    runtimeKind: z.enum(["pi-local", "claude-code-channel", "custom"]),
    instanceId: z.string().min(1).max(128),
    runtimeSessionId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(100),
    localCwd: z.string().max(1000).optional(),
    // Defaults to 'off' server-side for these coding-agent scratchpads; send
    // 'auto' to opt the session's scratchpad into GAM memory extraction.
    memoryMode: z.enum(MEMORY_MODES).optional(),
    // Optional owner-scoped label name to assign to the created scratchpad stream.
    labelName: z.string().trim().min(1).max(100).regex(/\S/).optional(),
    // Optional markdown description set on the new scratchpad (parsed to rich text,
    // same as message content) — e.g. an orchestrator's handover note. Surfaces as
    // a "set the description" timeline row and in the agent's prompt context. Only
    // applied when the session creates a fresh scratchpad, not on resume.
    description: z.string().max(STREAM_DESCRIPTION_MAX_MARKDOWN_LENGTH).optional(),
    // Create the linked scratchpad end-to-end encrypted (INV-E1: the flag lands in
    // the create transaction). `ownerKeyId` must be the bot OWNER's active UIK —
    // the harness wraps the generation-0 stream key to it (plus its own BIK) in a
    // follow-up provisioning call, because the wrap AAD binds to the server-minted
    // stream id. Personal bots only (a shared bot has no owner to wrap to).
    e2e: z.object({ ownerKeyId: z.string().min(1).max(128) }).optional(),
    // What to do when this identity's link exists but its scratchpad is archived.
    // "wait" (default) 409s with SCRATCHPAD_ARCHIVED — the archive-grace reattach
    // probe uses it so an unarchive within the window revives the SAME scratchpad.
    // "replace" retires the archived link (terminal, identity freed) and creates a
    // fresh scratchpad — cold starts use it so a deliberately archived scratchpad
    // can never wedge auto-connect for its project directory.
    ifArchived: z.enum(["wait", "replace"]).optional(),
    // Supervisors preflighting a known inventory row must not create a new
    // scratchpad when its runtime identity no longer has any link.
    ifMissing: z.enum(["create", "error"]).optional(),
    // Link this session to a new thread under an existing scratchpad instead of
    // minting one. `rootStreamId` must be a scratchpad the bot already has access
    // to; `anchorId` is the message/event it threads under.
    attachTo: z.object({ rootStreamId: z.string().min(1), anchorId: z.string().min(1) }).optional(),
  })
  .refine((data) => data.ifMissing !== "error" || data.ifArchived !== "replace", {
    message: 'ifMissing="error" cannot be combined with ifArchived="replace"',
    path: ["ifArchived"],
  })
  .refine(
    (data) =>
      !data.attachTo ||
      (data.description === undefined &&
        data.labelName === undefined &&
        data.memoryMode === undefined &&
        data.e2e === undefined &&
        data.ifArchived !== "replace" &&
        data.ifMissing !== "error"),
    {
      // attachTo joins an existing scratchpad; these options only make sense
      // when the call is minting a fresh one.
      message:
        'attachTo cannot be combined with description, labelName, memoryMode, e2e, ifArchived="replace", or ifMissing="error"',
      path: ["attachTo"],
    }
  )

// Generation-0 SSK wraps a sealed harness provisions right after creating its
// E2E scratchpad: one wrap for the stream owner's UIK and one for its own BIK.
// Wrap bytes are opaque HPKE ciphertext; slots are insert-only server-side.
export const provisionSessionKeyWrapsSchema = z.object({
  keyGeneration: z.number().int().min(0),
  wraps: z
    .array(
      z.object({
        recipientKind: z.enum(["user", "bot"]),
        recipientKeyId: z.string().min(1).max(128),
        wrapEnc: z.base64().min(1),
        wrapCt: z.base64().min(1),
      })
    )
    .min(1)
    .max(4),
})

export const renameRuntimeSessionSchema = z.object({
  instanceId: z.string().min(1).max(128),
  runtimeSessionId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(100),
})

export const rebindRuntimeSessionSchema = z.object({
  linkId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  runtimeSessionId: z.string().min(1).max(256),
  newInstanceId: z.string().min(1).max(128),
})

export const endRuntimeSessionSchema = z.object({
  instanceId: z.string().min(1).max(128),
  runtimeSessionId: z.string().min(1).max(256),
})

export const claimInvocationSchema = z.object({
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  instanceId: z.string().min(1).max(128),
  runtimeSessionId: z.string().min(1).max(256).optional(),
  supportedCapabilities: z.array(z.enum(BOT_INVOCATION_CAPABILITIES)).min(1),
  claimTtlSeconds: z.number().int().min(15).max(300).optional().default(60),
  // Restrict the claim to invocations answering into this stream. A connector
  // folding several queued messages into one turn can only fold messages that
  // share a response stream; without the filter it would have to claim first
  // and inspect after, and a claim it should not have taken cannot be released.
  responseStreamId: z.string().min(1).max(64).optional(),
})

export const renewInvocationClaimSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  claimTtlSeconds: z.number().int().min(15).max(300).optional().default(60),
  knownSourceRevision: z.number().int().min(0).optional(),
  restartRequiredRevision: z.number().int().min(0).optional(),
})

// Citations a bot attaches to its reply. `url` is a plain bounded string (not a
// strict URL) because workspace sources carry internal navigation links, not
// just web URLs — mirrors `SourceItem` in @threa/types.
export const sourceItemSchema = z.object({
  type: z.enum(SOURCE_TYPES).optional(),
  title: z.string().min(1).max(500),
  url: z.string().min(1).max(2000),
  snippet: z.string().max(2000).optional(),
})

// Sealed-message envelope framing (v2 StreamEnvelope): iv/aad base64. These
// fields are persisted verbatim and only decrypted later (in the owner's
// browser), so decodability is validated at the boundary — malformed base64
// that slips through becomes a permanently unreadable row. Mirrors the enclave's
// sealed validation (session-handlers.ts). Declared above the first user
// (`completeInvocationSchema`'s sealed ack) so the const is initialized in time.
const sealedStreamEnvelopeSchema = z.object({
  v: z.number(),
  keyGeneration: z.number().int().min(0),
  iv: z.base64().min(1),
  aad: z.base64().min(1),
})

export const completeInvocationSchema = z
  .object({
    instanceId: z.string().min(1).max(128),
    claimToken: z.string().min(1).max(256),
    sourceRevision: z.number().int().min(0).optional(),
    finalMessageMarkdown: z.string().min(1).max(50_000).optional(),
    noResponse: z.boolean().optional(),
    sources: z.array(sourceItemSchema).max(50).optional(),
    metadata: messageMetadataSchema.optional(),
    // Sealed variant of `finalMessageMarkdown`, for a session-control ack on an
    // E2E scratchpad: the "Model changed …" confirmation sealed under the stream
    // key. Session-control invocations have no sealed session, so they complete
    // here rather than via `/sealed-complete`. `messageId` is client-minted (it
    // binds the seal AAD); content is ciphertext the server never reads (INV-E7).
    // Mutually exclusive with `finalMessageMarkdown`.
    sealedReply: z
      .object({
        messageId: z.string().min(1).max(128),
        ciphertext: z.base64().min(1),
        envelope: sealedStreamEnvelopeSchema,
      })
      .optional(),
  })
  .refine((value) => value.noResponse === true || value.finalMessageMarkdown != null || value.sealedReply != null, {
    message: "Either finalMessageMarkdown, sealedReply, or noResponse is required",
    path: ["finalMessageMarkdown"],
  })
  .refine((value) => !(value.finalMessageMarkdown != null && value.sealedReply != null), {
    message: "Provide finalMessageMarkdown or sealedReply, not both",
    path: ["sealedReply"],
  })

export const failInvocationSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  errorMessage: z.string().min(1).max(1000),
})

// One plaintext message posted into a turn's own response stream: the claim, not
// a caller-chosen stream id, decides where it lands and which session it belongs
// to. `clientMessageId` is the idempotency key an ambiguous retry re-sends under.
export const sendInvocationMessageSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  content: z.string().min(1).max(50_000),
  clientMessageId: z.string().min(1).max(128).optional(),
  metadata: messageMetadataSchema.optional(),
})

export const recordInvocationStepSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  stepType: z.enum(AGENT_STEP_TYPES),
  content: z.string().min(1).max(10_000),
  statusText: z.string().max(200).optional(),
  // Client idempotency key: a step re-sent under the same id dedups server-side.
  clientStepId: z.string().min(1).max(128).optional(),
})

// One sealed trace step a sealed-capable bot harness finalized (the external
// sibling of the enclave's `/steps`). `stepType` + `messageId` + timing are
// clear; the content is ciphertext the server can't read (INV-E7). Auth is the
// bot API key + the neutral callback token header, not body fields — the body is
// exactly the `SealedStep` wire shape.
export const recordSealedInvocationStepSchema = z.object({
  stepId: z.string().min(1).max(128),
  stepType: z.enum(AGENT_STEP_TYPES),
  messageId: z.string().min(1).max(128).optional(),
  ciphertext: z.base64().min(1),
  envelope: sealedStreamEnvelopeSchema,
  durationMs: z.number().int().min(0).optional(),
})

// One in-flight sealed trace step *start* (the external sibling of the enclave's
// `/steps/started`). Content is sealed when already known (reasoning/reply) and
// absent for tools whose result isn't known yet, so ciphertext + envelope are
// optional here; a matching `recordSealedInvocationStep` finalizes the same
// `stepId` in place.
export const startSealedInvocationStepSchema = z.object({
  stepId: z.string().min(1).max(128),
  stepType: z.enum(AGENT_STEP_TYPES),
  messageId: z.string().min(1).max(128).optional(),
  ciphertext: z.base64().min(1).optional(),
  envelope: sealedStreamEnvelopeSchema.optional(),
})

// E2E attachment rows bound to a sealed message. The ids are cleartext wire
// metadata (the server already holds the placeholder rows); the per-file keys
// and real filenames ride only inside the sealed payload's `attachmentRefs`.
const sealedAttachmentIdsSchema = z.array(z.string().min(1).max(128)).max(16).optional()

// One sealed message posted by a sealed turn — mid-turn, or as a follow-up after
// it completed (the external sibling of the enclave streaming replies to its
// session `/messages` callback). `messageId` is client-minted — it binds the
// seal AAD and doubles as the idempotency key — while the content is ciphertext
// the server can't read (INV-E7). Auth is the bot API key + the neutral callback
// token header.
export const sendSealedInvocationMessageSchema = z.object({
  messageId: z.string().min(1).max(128),
  ciphertext: z.base64().min(1),
  envelope: sealedStreamEnvelopeSchema,
  attachmentIds: sealedAttachmentIdsSchema,
})

// The sealed variant of `completeInvocationSchema` (the external sibling of the
// enclave's `/complete`). Carries the turn's final sealed reply — `messageId` is
// clear (it keys the row and binds the seal AAD) while the content is ciphertext
// the server can't read (INV-E7) — or `noResponse` when the turn produced none.
// Auth is the bot API key + the neutral callback token header, not body claim
// fields, so neither `instanceId` nor `claimToken` appears here.
export const completeSealedInvocationSchema = z
  .object({
    sourceRevision: z.number().int().min(0).optional(),
    reply: z
      .object({
        messageId: z.string().min(1).max(128),
        ciphertext: z.base64().min(1),
        envelope: sealedStreamEnvelopeSchema,
        attachmentIds: sealedAttachmentIdsSchema,
      })
      .optional(),
    noResponse: z.boolean().optional(),
  })
  .refine((value) => value.noResponse === true || value.reply != null, {
    message: "Either reply or noResponse is required",
    path: ["reply"],
  })

export const listMessagesSchema = z
  .object({
    before: z.string().regex(/^\d+$/, "must be a numeric sequence").optional(),
    after: z.string().regex(/^\d+$/, "must be a numeric sequence").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  })
  .refine((data) => !(data.before && data.after), {
    message: "Provide at most one of 'before' or 'after'",
  })

// Public subset of the internal `ConversationDirective`: declare the message's
// conversation at send instead of leaving it to the async boundary extractor —
// the same mechanism the board's composer uses. `existing` must target a
// conversation under the same effective root as the target stream (one-root
// rule; violations return 400 CONVERSATION_NOT_IN_ROOT). The thread-split
// intents (`threadFromMessage`, `newSubtopic`) stay internal until an external
// consumer needs them (INV-36).
export const publicConversationDirectiveSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("new") }),
  z.object({ intent: z.literal("existing"), conversationId: z.string().min(1).max(64) }),
])

export const sendMessageSchema = z.object({
  content: z.string().min(1, "content is required"),
  clientMessageId: z.string().max(128).optional(),
  metadata: messageMetadataSchema.optional(),
  conversation: publicConversationDirectiveSchema.optional(),
})

export const updateMessageSchema = z.object({
  content: z.string().min(1, "content is required"),
})

export const updateStreamSchema = z.object({
  // Markdown, parsed server-side to the canonical ProseMirror description (same
  // wire format as message `content`). An empty string clears the description.
  description: z.string().max(STREAM_DESCRIPTION_MAX_MARKDOWN_LENGTH),
})

export const findMessagesByMetadataSchema = z.object({
  /** AND-containment filter: a message matches when its metadata contains every key/value pair. */
  metadata: messageMetadataFilterSchema,
  /** Optional — narrow the search to a single accessible stream. */
  streamId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
})

export const listConversationsSchema = z.object({
  /** Narrow to conversations under one stream's effective root (a thread id resolves to its root). */
  streamId: z.string().optional(),
  status: z.enum(CONVERSATION_STATUSES).optional(),
  /** Opaque cursor from a prior page's `cursor`. */
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
})

export const listConversationMessagesSchema = z.object({
  /** Opaque cursor from a prior page's `cursor`. */
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
})

export const listMembersSchema = z.object({
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

export const listUsersSchema = z.object({
  query: z.string().optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
})

export const listMyBotsSchema = z.object({
  /** Optional capability filter — currently only `interactive` is defined. */
  traits: z.enum(BOT_TRAITS).optional(),
})

// ── Delegations (roadmap 5.3) — a local agent's lifecycle over delegated tasks.

export const listDelegationsQuerySchema = z.object({
  /** Only the claimable queue is listed today; the enum grows when a real consumer needs more (INV-36). */
  status: z.literal("open").optional().default("open"),
  /** Only delegations whose availability changed after this instant. */
  since: z.string().datetime().optional(),
})

export const claimDelegationSchema = z.object({
  /** Human-readable identity of the claiming agent, shown on the card (e.g. "Kris's MacBook / Claude Code"). */
  claimedByLabel: z.string().min(1).max(200),
  /**
   * Crash-recovery key, persisted by the runner BEFORE calling claim. A retry
   * bearing the live claim's key re-keys it (fresh token + lease) instead of 409.
   */
  idempotencyKey: z.string().min(8).max(128).optional(),
})

export const reportDelegationStatusSchema = z.object({
  /** Free-text progress note shown on the card; each report replaces the previous note. */
  statusNote: z.string().min(1).max(2000).optional(),
})

export const completeDelegationSchema = z.object({
  /** Result message (markdown) posted to the delegation's stream as the key's identity. Omit to complete without a message. */
  resultMarkdown: z.string().min(1).max(50000).optional(),
  /** External references stamped on the result message (sendMessage parity) — e.g. `{"github.pr": "…"}`, queryable via find-by-metadata. */
  metadata: messageMetadataSchema.optional(),
})

export const failDelegationSchema = z.object({
  errorMessage: z.string().min(1).max(2000),
})

export const requestDelegationAccessSchema = z.object({
  /** Human-readable identity of the requesting runner, shown on the access-request card (e.g. "Kris's MacBook"). */
  requestedByLabel: z.string().max(200).optional(),
})
