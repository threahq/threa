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
  MEMO_TYPES,
  KNOWLEDGE_TYPES,
  EXTRACTION_CONTENT_TYPES,
} from "@threa/types"
import { messageMetadataSchema, messageMetadataFilterSchema } from "../messaging"

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

export const upsertPresenceSchema = z.object({
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  instanceId: z.string().min(1).max(128),
  displayName: z.string().max(100).optional(),
  status: z.enum(BOT_RUNTIME_STATUSES),
  acceptingInvocations: z.boolean(),
  capabilities: z.record(z.string(), z.unknown()).optional().default({}),
  statusText: z.string().max(200).optional(),
})

export const createRuntimeSessionSchema = z.object({
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  instanceId: z.string().min(1).max(128),
  runtimeSessionId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(100),
  localCwd: z.string().max(1000).optional(),
})

export const claimInvocationSchema = z.object({
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  instanceId: z.string().min(1).max(128),
  supportedCapabilities: z.array(z.enum(BOT_INVOCATION_CAPABILITIES)).min(1),
  claimTtlSeconds: z.number().int().min(15).max(300).optional().default(60),
})

export const renewInvocationClaimSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  claimTtlSeconds: z.number().int().min(15).max(300).optional().default(60),
})

export const completeInvocationSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  finalMessageMarkdown: z.string().min(1).max(50_000),
  metadata: messageMetadataSchema.optional(),
})

export const failInvocationSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  errorMessage: z.string().min(1).max(1000),
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
