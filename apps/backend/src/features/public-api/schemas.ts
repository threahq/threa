/**
 * Request validation schemas for the public API.
 *
 * Shared by handlers (runtime validation) and routes (doc generation).
 * Extracted to its own file to avoid a circular dependency between
 * handlers.ts and routes.ts.
 */
import { z } from "zod"
import {
  BOT_INVOCATION_CAPABILITIES,
  BOT_RUNTIME_KINDS,
  BOT_RUNTIME_STATUSES,
  BOT_TRAITS,
  STREAM_TYPES,
  MEMORY_MODES,
  MEMO_TYPES,
  KNOWLEDGE_TYPES,
  EXTRACTION_CONTENT_TYPES,
  AGENT_STEP_TYPES,
  SOURCE_TYPES,
  LABELABLE_RESOURCE_TYPES,
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
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(PUBLIC_MEMO_SEARCH_MAX_LIMIT).optional().default(20),
})

export const searchAttachmentsSchema = z.object({
  query: z.string().min(1, "query is required"),
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
    statusText: z.string().max(200).optional(),
    ...botIdentityKeyFields,
  })
  .refine(bothOrNeitherBotIdentityKey, {
    message: "publicKey and publicKeyId must be provided together",
    path: ["publicKey"],
  })

export const createRuntimeSessionSchema = z.object({
  // The runtime kinds whose active-scratchpad turns are pinned to a session
  // link (see runtime-kind-config). Other kinds dispatch untargeted and never
  // create a link, so they have no business calling this endpoint.
  runtimeKind: z.enum(["pi-local", "claude-code-channel"]),
  instanceId: z.string().min(1).max(128),
  runtimeSessionId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(100),
  localCwd: z.string().max(1000).optional(),
  // Defaults to 'off' server-side for these coding-agent scratchpads; send
  // 'auto' to opt the session's scratchpad into GAM memory extraction.
  memoryMode: z.enum(MEMORY_MODES).optional(),
  // Optional owner-scoped label name to assign to the created scratchpad stream.
  labelName: z.string().trim().min(1).max(100).regex(/\S/).optional(),
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

export const claimInvocationSchema = z.object({
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  instanceId: z.string().min(1).max(128),
  runtimeSessionId: z.string().min(1).max(256).optional(),
  supportedCapabilities: z.array(z.enum(BOT_INVOCATION_CAPABILITIES)).min(1),
  claimTtlSeconds: z.number().int().min(15).max(300).optional().default(60),
})

export const renewInvocationClaimSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  claimTtlSeconds: z.number().int().min(15).max(300).optional().default(60),
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

export const completeInvocationSchema = z
  .object({
    instanceId: z.string().min(1).max(128),
    claimToken: z.string().min(1).max(256),
    finalMessageMarkdown: z.string().min(1).max(50_000).optional(),
    noResponse: z.boolean().optional(),
    sources: z.array(sourceItemSchema).max(50).optional(),
    metadata: messageMetadataSchema.optional(),
  })
  .refine((value) => value.noResponse === true || value.finalMessageMarkdown != null, {
    message: "Either finalMessageMarkdown or noResponse is required",
    path: ["finalMessageMarkdown"],
  })

export const failInvocationSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  errorMessage: z.string().min(1).max(1000),
})

export const recordInvocationStepSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  stepType: z.enum(AGENT_STEP_TYPES),
  content: z.string().min(1).max(10_000),
  statusText: z.string().max(200).optional(),
})

// These base64 fields are persisted verbatim and only decrypted later (in the
// owner's browser), so decodability is validated at the boundary — malformed
// base64 that slips through becomes a permanently unreadable step. Mirrors the
// enclave's sealed-step validation (session-handlers.ts).
const sealedStreamEnvelopeSchema = z.object({
  v: z.number(),
  keyGeneration: z.number().int().min(0),
  iv: z.base64().min(1),
  aad: z.base64().min(1),
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

// The sealed variant of `completeInvocationSchema` (the external sibling of the
// enclave's `/complete`). Carries the turn's final sealed reply — `messageId` is
// clear (it keys the row and binds the seal AAD) while the content is ciphertext
// the server can't read (INV-E7) — or `noResponse` when the turn produced none.
// Auth is the bot API key + the neutral callback token header, not body claim
// fields, so neither `instanceId` nor `claimToken` appears here.
export const completeSealedInvocationSchema = z
  .object({
    reply: z
      .object({
        messageId: z.string().min(1).max(128),
        ciphertext: z.base64().min(1),
        envelope: sealedStreamEnvelopeSchema,
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

export const sendMessageSchema = z.object({
  content: z.string().min(1, "content is required"),
  clientMessageId: z.string().max(128).optional(),
  metadata: messageMetadataSchema.optional(),
})

export const updateMessageSchema = z.object({
  content: z.string().min(1, "content is required"),
})

export const findMessagesByMetadataSchema = z.object({
  /** AND-containment filter: a message matches when its metadata contains every key/value pair. */
  metadata: messageMetadataFilterSchema,
  /** Optional — narrow the search to a single accessible stream. */
  streamId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
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
