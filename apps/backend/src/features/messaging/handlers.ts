import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { withTransaction } from "../../db"
import type { EventService } from "./event-service"
import type { StreamService } from "../streams"
import type { Message } from "./repository"
import { StreamEventRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import type { CommandRegistry } from "../commands"
import { type CommandDispatchedPayload, E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"
import { serializeBigInt } from "@threa/backend-common"
import { eventId, commandId as generateCommandId } from "../../lib/id"
import { toShortcode, normalizeMessage, toEmoji } from "../emoji"
import { collectAttachmentReferenceIds, parseMarkdown, serializeToMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import { messageMetadataSchema } from "./metadata-schema"

// Fields shared by every create/update variant. Defining once keeps the
// six schemas from drifting when a per-message option is added.
// `confirmedPrivacyWarning` is required when a share node crosses a privacy
// boundary; the service returns 409 + `SHARE_PRIVACY_CONFIRMATION_REQUIRED`
// otherwise.
const commonMessageOptionsSchema = {
  attachmentIds: z.array(z.string()).optional(),
  clientMessageId: z.string().min(1).optional(),
  metadata: messageMetadataSchema.optional(),
  confirmedPrivacyWarning: z.boolean().optional(),
}

const contentJsonSchema = z.object({
  type: z.literal("doc"),
  content: z.array(z.any()),
})

// Schema for JSON input to an existing stream (from rich clients)
const createMessageJsonToStreamSchema = z.object({
  streamId: z.string().min(1, "streamId is required"),
  contentJson: contentJsonSchema,
  contentMarkdown: z.string().optional(),
  ...commonMessageOptionsSchema,
})

// Schema for markdown input to an existing stream (from AI/external)
const createMessageMarkdownToStreamSchema = z.object({
  streamId: z.string().min(1, "streamId is required"),
  content: z.string().min(1, "content is required"),
  ...commonMessageOptionsSchema,
})

// Schema for JSON input to a DM target user (lazy stream creation on first message)
const createMessageJsonToDmSchema = z.object({
  dmUserId: z.string().min(1, "dmUserId is required"),
  contentJson: contentJsonSchema,
  contentMarkdown: z.string().optional(),
  ...commonMessageOptionsSchema,
})

// Schema for markdown input to a DM target user (lazy stream creation on first message)
const createMessageMarkdownToDmSchema = z.object({
  dmUserId: z.string().min(1, "dmUserId is required"),
  content: z.string().min(1, "content is required"),
  ...commonMessageOptionsSchema,
})

// Schema for E2E ciphertext input to an existing E2E-enabled stream. The
// handler verifies the target stream is in `e2e_streams` (INV-E1) so a
// plaintext writer cannot impersonate an encrypted message and vice versa.
// `contentJson` / `contentMarkdown` are intentionally absent: the handler
// substitutes opaque placeholders for the projection so plaintext consumers
// short-circuit on `e2eStreams.isE2eStream`.
//
// Size caps bound the per-message storage footprint — without them a
// workspace member could post multi-MB envelopes that never decrypt for
// anyone but bloat `messages.envelope` (JSONB) and `messages.ciphertext`
// (BYTEA). 1 MB of base64 ciphertext leaves ~750 KB of plaintext, plenty
// for messages; the 100-recipient cap covers Phase 4 per-device wraps.
const MAX_E2E_CIPHERTEXT_BASE64_BYTES = 1_000_000
const MAX_E2E_RECIPIENTS = 100
const MAX_E2E_RECIPIENT_FIELD_BYTES = 4096
const e2eRecipientSchema = z.object({
  recipientKeyId: z.string().min(1).max(256),
  enc: z.string().min(1).max(MAX_E2E_RECIPIENT_FIELD_BYTES),
  ct: z.string().min(1).max(MAX_E2E_RECIPIENT_FIELD_BYTES),
})
// v1 — per-message recipient fan-out (@threa/crypto `Envelope`). The message
// key is wrapped to each recipient inline. Kept for read-compat; the SSK path
// (v2) is the direction for new messages.
const e2eEnvelopeV1Schema = z.object({
  v: z.number().int().positive(),
  ciphertext: z.string().min(1).max(MAX_E2E_CIPHERTEXT_BASE64_BYTES),
  iv: z.string().min(1).max(64),
  aad: z.string().max(4096),
  recipients: z.array(e2eRecipientSchema).min(1).max(MAX_E2E_RECIPIENTS),
})

// v2 — per-stream symmetric key (@threa/crypto `StreamEnvelope`). No inline
// recipients: the SSK is wrapped out of band in `stream_e2e_key_wraps`. The
// envelope carries only the framing; the AES-GCM ciphertext rides the
// top-level `ciphertext` field. `keyGeneration` selects which SSK generation
// (and therefore which wrap) opens it.
const e2eEnvelopeV2Schema = z.object({
  v: z.number().int().positive(),
  keyGeneration: z.number().int().nonnegative(),
  iv: z.string().min(1).max(64),
  aad: z.string().min(1).max(4096),
})

// The two envelope shapes are structurally disjoint (v2 has `keyGeneration`
// and no `recipients`; v1 has `recipients` and an inline `ciphertext`), so the
// union discriminates without a version literal. v2 is tried first since it is
// the path new messages take.
const e2eEnvelopeSchema = z.union([e2eEnvelopeV2Schema, e2eEnvelopeV1Schema])
const createMessageE2eToStreamSchema = z.object({
  streamId: z.string().min(1, "streamId is required"),
  ciphertext: z.string().min(1, "ciphertext is required").max(MAX_E2E_CIPHERTEXT_BASE64_BYTES),
  envelope: e2eEnvelopeSchema,
  e2eVersion: z.number().int().positive(),
  // Opaque (`e2e_only`) attachment rows to bind to this message. The per-file
  // keys + real metadata ride sealed inside `ciphertext`; only the ids cross
  // the wire so the rows can be attached to the message.
  attachmentIds: z.array(z.string()).optional(),
  clientMessageId: z.string().min(1).optional(),
})

// Plaintext-only union (used by `normalizeContent` and the post-E2E-gate
// branch in the create handler). Splitting this out keeps the narrowing
// surface small: E2E messages never flow through markdown normalization or
// attachment parsing.
const createPlaintextMessageSchema = z.union([
  createMessageJsonToStreamSchema,
  createMessageMarkdownToStreamSchema,
  createMessageJsonToDmSchema,
  createMessageMarkdownToDmSchema,
])

// Union schema - accepts plaintext or E2E variants
const createMessageSchema = z.union([
  createMessageJsonToStreamSchema,
  createMessageMarkdownToStreamSchema,
  createMessageJsonToDmSchema,
  createMessageMarkdownToDmSchema,
  createMessageE2eToStreamSchema,
])

// Update can also be either format
const updateMessageJsonSchema = z.object({
  contentJson: contentJsonSchema,
  contentMarkdown: z.string().optional(),
  confirmedPrivacyWarning: z.boolean().optional(),
})

const updateMessageMarkdownSchema = z.object({
  content: z.string().min(1, "content is required"),
  confirmedPrivacyWarning: z.boolean().optional(),
})

const updateMessageSchema = z.union([updateMessageJsonSchema, updateMessageMarkdownSchema])

const addReactionSchema = z.object({
  emoji: z.string().min(1, "emoji is required"),
})

const moveMessagesToThreadSchema = z.object({
  sourceStreamId: z.string().min(1, "sourceStreamId is required"),
  targetMessageId: z.string().min(1, "targetMessageId is required"),
  messageIds: z.array(z.string().min(1)).min(1).max(100),
  leaseKey: z.string().min(1, "leaseKey is required"),
})

const validateMoveMessagesToThreadSchema = moveMessagesToThreadSchema.omit({ leaseKey: true })

export {
  createMessageSchema,
  updateMessageSchema,
  addReactionSchema,
  moveMessagesToThreadSchema,
  validateMoveMessagesToThreadSchema,
}

/**
 * Normalize input to both JSON and markdown formats.
 * - If JSON provided: serialize to markdown, then normalize the markdown projection
 * - If markdown provided: normalize emoji, parse to JSON
 * Emoji normalization converts raw emoji (👍) to shortcodes (:+1:).
 */
function normalizeContent(input: z.infer<typeof createPlaintextMessageSchema> | z.infer<typeof updateMessageSchema>): {
  contentJson: JSONContent
  contentMarkdown: string
} {
  if ("contentJson" in input) {
    // Rich client: JSON provided, trust the structure but still normalize the
    // markdown projection so editable raw emoji text becomes canonical shortcode
    // content for storage, usage tracking, and external consumers.
    const contentMarkdown = normalizeMessage(input.contentMarkdown ?? serializeToMarkdown(input.contentJson))
    return { contentJson: input.contentJson, contentMarkdown }
  } else {
    // AI/external: Markdown provided, normalize and parse to JSON
    const normalizedMarkdown = normalizeMessage(input.content)
    const contentJson = parseMarkdown(normalizedMarkdown, undefined, toEmoji)
    return { contentJson, contentMarkdown: normalizedMarkdown }
  }
}

function serializeMessage(msg: Message) {
  // `msg.ciphertext` is a Node `Buffer` (BYTEA → driver), which `serializeBigInt`
  // would walk with `Object.entries` and emit as a byte-indexed object on the
  // wire. Base64-encode to match the `Message.ciphertext: string | null`
  // contract clients expect.
  const ciphertext = msg.ciphertext ? msg.ciphertext.toString("base64") : null
  return serializeBigInt({ ...msg, ciphertext })
}

// Plaintext consumers (search index, message-formatter, outbox handlers) gate
// on `isE2eStream` before reading these fields, so the value never reaches a
// user. `E2E_PLACEHOLDER_CONTENT_MARKDOWN` is shared from `@threa/types` so
// the frontend decrypt path can detect it byte-identically; we derive the
// JSON doc shape locally because ProseMirror types aren't worth shipping.
const E2E_PLACEHOLDER_CONTENT_JSON: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: E2E_PLACEHOLDER_CONTENT_MARKDOWN }] }],
}

interface DetectedCommand {
  name: string
  args: string
}

/**
 * Detect if the first inline node is a command.
 * Currently only checks the very first element - function name allows future expansion.
 */
function detectCommand(contentJson: JSONContent): DetectedCommand | null {
  const firstBlock = contentJson.content?.[0]
  if (firstBlock?.type !== "paragraph") return null

  const firstInline = firstBlock.content?.[0]
  if (firstInline?.type !== "command") return null

  const attrs = firstInline.attrs as { name: string; args?: string } | undefined
  if (!attrs?.name) return null

  return {
    name: attrs.name,
    args: attrs.args ?? "",
  }
}

interface Dependencies {
  pool: Pool
  eventService: EventService
  streamService: StreamService
  commandRegistry: CommandRegistry
}

export function createMessageHandlers({ pool, eventService, streamService, commandRegistry }: Dependencies) {
  return {
    async create(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = createMessageSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const data = result.data

      const stream = await streamService.resolveWritableMessageStream({
        workspaceId,
        userId: userId,
        target: "dmUserId" in data ? { dmUserId: data.dmUserId } : { streamId: data.streamId },
      })
      const streamId = stream.id

      // INV-E1: a plaintext request must not land in an E2E stream and an E2E
      // request must not land in a plaintext stream. Either direction would
      // produce a row that violates the encryption guarantee, so we mismatch
      // here before any insert occurs. `resolveWritableMessageStream` already
      // populates `e2eEnabled` off the `e2e_streams` LEFT JOIN, so we read
      // it off the resolved stream instead of issuing a second SELECT.
      const isE2eStream = stream.e2eEnabled === true
      const isE2eRequest = "ciphertext" in data
      if (isE2eStream !== isE2eRequest) {
        return res.status(400).json({
          error: isE2eStream
            ? "Stream is end-to-end encrypted; send ciphertext, envelope, and e2eVersion"
            : "Stream is not end-to-end encrypted; send plaintext content",
          code: isE2eStream ? "E2E_STREAM_REQUIRES_CIPHERTEXT" : "E2E_PAYLOAD_REQUIRES_E2E_STREAM",
        })
      }

      if ("ciphertext" in data) {
        // E2E messages are opaque: no slash-command parsing, no markdown
        // normalization. The projection stores a fixed placeholder so plaintext
        // consumers (search, summary, outbox) can short-circuit on `isE2eStream`
        // without crashing on null content. Attachments still bind: the rows are
        // `e2e_only` ciphertext (no real content to gate on), and the same
        // workspace + shareable check the plaintext path runs covers them.
        const message = await eventService.createMessage({
          workspaceId,
          streamId,
          authorId: userId,
          authorType: "user",
          contentJson: E2E_PLACEHOLDER_CONTENT_JSON,
          contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
          ciphertext: Buffer.from(data.ciphertext, "base64"),
          envelope: data.envelope,
          e2eVersion: data.e2eVersion,
          attachmentIds: data.attachmentIds && data.attachmentIds.length > 0 ? data.attachmentIds : undefined,
          clientMessageId: data.clientMessageId,
        })
        return res.status(201).json({ message: serializeMessage(message) })
      }

      // Explicit `data.attachmentIds` is the fresh-upload list (each row's
      // `messageId === null`, claimed by `attachToMessage` on send).
      // The contentJson-derived list catches inline `attachment:` references
      // — fresh uploads aren't represented there, references are.
      // Merging both into the deduped union covers all flavors with one
      // gate run + one projection write (mirrors the edit path).
      const explicitAttachmentIds = data.attachmentIds ?? []

      // Check for slash command in first node BEFORE normalization (normalization loses command nodes)
      const originalContentJson = "contentJson" in data ? data.contentJson : undefined
      const detectedCommand = originalContentJson ? detectCommand(originalContentJson) : null

      if (detectedCommand && commandRegistry.has(detectedCommand.name)) {
        // Route to command dispatch instead of message creation
        const cmdId = generateCommandId()
        const evtId = eventId()

        const event = await withTransaction(pool, async (client) => {
          const evt = await StreamEventRepository.insert(client, {
            id: evtId,
            streamId,
            eventType: "command_dispatched",
            payload: {
              commandId: cmdId,
              name: detectedCommand.name,
              args: detectedCommand.args,
              status: "dispatched",
            } satisfies CommandDispatchedPayload,
            actorId: userId,
            actorType: "user",
          })

          await OutboxRepository.insert(client, "command:dispatched", {
            workspaceId,
            streamId,
            event: serializeBigInt(evt),
            authorId: userId,
          })

          return evt
        })

        return res.status(202).json({
          command: {
            id: cmdId,
            name: detectedCommand.name,
            args: detectedCommand.args,
            status: "dispatched",
          },
          event: serializeBigInt(event),
        })
      }

      // Normalize to both JSON and markdown formats for normal message creation
      const { contentJson, contentMarkdown } = normalizeContent(data)
      // Union of explicit fresh-upload ids and inline references parsed from
      // the canonical contentJson. Without this, a markdown POST containing
      // `[Image #1](attachment:att_x)` would skip the access gate AND the
      // attachment_references projection write.
      const inlineRefIds = collectAttachmentReferenceIds(contentJson)
      const attachmentIds = [...new Set([...explicitAttachmentIds, ...inlineRefIds])]

      // Normal message creation
      const message = await eventService.createMessage({
        workspaceId,
        streamId,
        authorId: userId,
        authorType: "user",
        contentJson,
        contentMarkdown,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        clientMessageId: data.clientMessageId,
        metadata: data.metadata,
        confirmedPrivacyWarning: data.confirmedPrivacyWarning,
      })

      res.status(201).json({ message: serializeMessage(message) })
    },

    async update(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { messageId } = req.params

      const result = updateMessageSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const existing = await eventService.getMessageById(messageId)
      if (!existing) {
        return res.status(404).json({ error: "Message not found" })
      }

      // Read-access gate (visibility + workspace + thread inheritance), not
      // a plain stream_members check — public channels and inherited thread
      // access need to allow the message author through. The author-only
      // restriction below still enforces "edit your own".
      const accessibleStream = await streamService.tryAccess(existing.streamId, workspaceId, userId)
      if (!accessibleStream) {
        return res.status(404).json({ error: "Message not found" })
      }

      if (existing.authorId !== userId) {
        return res.status(403).json({ error: "Can only edit your own messages" })
      }

      // Normalize to both JSON and markdown formats
      const { contentJson, contentMarkdown } = normalizeContent(result.data)

      // Derive inline attachment ids from the new contentJson so event-service
      // can refresh the `attachment_references` projection in sync (INV-7).
      // Edits don't accept fresh-upload ids today (the schema only takes
      // content), so this is reference-only by construction.
      const attachmentIds = collectAttachmentReferenceIds(contentJson)

      const message = await eventService.editMessage({
        workspaceId,
        messageId,
        streamId: existing.streamId,
        contentJson,
        contentMarkdown,
        actorId: userId,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        confirmedPrivacyWarning: result.data.confirmedPrivacyWarning,
      })

      if (!message) {
        return res.status(404).json({ error: "Message not found" })
      }

      res.json({ message: serializeMessage(message) })
    },

    async moveToThread(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = moveMessagesToThreadSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      await streamService.resolveWritableMessageStream({
        workspaceId,
        userId,
        target: { streamId: result.data.sourceStreamId },
      })

      const moveResult = await eventService.moveMessagesToThread({
        workspaceId,
        sourceStreamId: result.data.sourceStreamId,
        targetMessageId: result.data.targetMessageId,
        messageIds: result.data.messageIds,
        actorId: userId,
        leaseKey: result.data.leaseKey,
      })

      res.json({
        sourceStreamId: moveResult.sourceStreamId,
        destinationStreamId: moveResult.destinationStreamId,
        targetMessageId: moveResult.targetMessageId,
        movedMessageIds: moveResult.movedMessageIds,
        thread: moveResult.thread,
        events: moveResult.events,
        removedEventIds: moveResult.removedEventIds,
        sourceTombstoneEvent: moveResult.sourceTombstoneEvent,
      })
    },

    async validateMoveToThread(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = validateMoveMessagesToThreadSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      await streamService.resolveWritableMessageStream({
        workspaceId,
        userId,
        target: { streamId: result.data.sourceStreamId },
      })

      const validation = await eventService.validateMoveMessagesToThread({
        workspaceId,
        sourceStreamId: result.data.sourceStreamId,
        targetMessageId: result.data.targetMessageId,
        messageIds: result.data.messageIds,
        actorId: userId,
      })

      res.json(validation)
    },

    async delete(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { messageId } = req.params

      const existing = await eventService.getMessageById(messageId)
      if (!existing) {
        return res.status(404).json({ error: "Message not found" })
      }

      // Same read-access reasoning as `update`: gate on tryAccess (visibility
      // + workspace + thread inheritance), then enforce author-only below.
      const accessibleStream = await streamService.tryAccess(existing.streamId, workspaceId, userId)
      if (!accessibleStream) {
        return res.status(404).json({ error: "Message not found" })
      }

      if (existing.authorId !== userId) {
        return res.status(403).json({ error: "Can only delete your own messages" })
      }

      await eventService.deleteMessage({
        workspaceId,
        messageId,
        streamId: existing.streamId,
        actorId: userId,
      })

      res.status(204).send()
    },

    async addReaction(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { messageId } = req.params

      const result = addReactionSchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const shortcode = toShortcode(result.data.emoji)
      if (!shortcode) {
        return res.status(400).json({ error: "Invalid emoji" })
      }

      const existing = await eventService.getMessageById(messageId)
      if (!existing) {
        return res.status(404).json({ error: "Message not found" })
      }

      // Reactions are participation by anyone who can read the message.
      // Plain `isMember` would reject workspace members reacting in a public
      // channel they haven't joined and threads they're reading via root
      // inheritance — neither is the intent.
      const accessibleStream = await streamService.tryAccess(existing.streamId, workspaceId, userId)
      if (!accessibleStream) {
        return res.status(404).json({ error: "Message not found" })
      }

      const message = await eventService.addReaction({
        workspaceId,
        messageId,
        streamId: existing.streamId,
        emoji: shortcode,
        userId,
      })

      if (!message) {
        return res.status(404).json({ error: "Message not found" })
      }

      res.json({ message: serializeMessage(message) })
    },

    async removeReaction(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { messageId, emoji } = req.params

      const shortcode = toShortcode(emoji)
      if (!shortcode) {
        return res.status(400).json({ error: "Invalid emoji" })
      }

      const existing = await eventService.getMessageById(messageId)
      if (!existing) {
        return res.status(404).json({ error: "Message not found" })
      }

      // Mirror addReaction: read-access gate so users can un-react in any
      // stream they can read, including public channels and inherited
      // thread access.
      const accessibleStream = await streamService.tryAccess(existing.streamId, workspaceId, userId)
      if (!accessibleStream) {
        return res.status(404).json({ error: "Message not found" })
      }

      const message = await eventService.removeReaction({
        workspaceId,
        messageId,
        streamId: existing.streamId,
        emoji: shortcode,
        userId,
      })

      if (!message) {
        return res.status(404).json({ error: "Message not found" })
      }

      res.json({ message: serializeMessage(message) })
    },

    async getHistory(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { messageId } = req.params

      const existing = await eventService.getMessageById(messageId)
      if (!existing || existing.deletedAt) {
        return res.status(404).json({ error: "Message not found" })
      }

      // Edit-history is a pure read of a message the viewer can see.
      // Same read-access semantics as the message itself — gate on
      // tryAccess, not bare membership.
      const accessibleStream = await streamService.tryAccess(existing.streamId, workspaceId, userId)
      if (!accessibleStream) {
        return res.status(404).json({ error: "Message not found" })
      }

      const versions = await eventService.getMessageVersions(messageId)
      res.json({ versions: versions.map(serializeBigInt) })
    },
  }
}
