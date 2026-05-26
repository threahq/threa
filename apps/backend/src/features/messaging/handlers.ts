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
import type { CommandDispatchedPayload } from "@threa/types"
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

// Union schema - accepts either format
const createMessageSchema = z.union([
  createMessageJsonToStreamSchema,
  createMessageMarkdownToStreamSchema,
  createMessageJsonToDmSchema,
  createMessageMarkdownToDmSchema,
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
function normalizeContent(input: z.infer<typeof createMessageSchema> | z.infer<typeof updateMessageSchema>): {
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
  return serializeBigInt(msg)
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
      // Explicit `data.attachmentIds` is the fresh-upload list (each row's
      // `messageId === null`, claimed by `attachToMessage` on send).
      // The contentJson-derived list catches inline `attachment:` references
      // — fresh uploads aren't represented there, references are.
      // Merging both into the deduped union covers all flavors with one
      // gate run + one projection write (mirrors the edit path).
      const explicitAttachmentIds = data.attachmentIds ?? []

      const stream = await streamService.resolveWritableMessageStream({
        workspaceId,
        userId: userId,
        target: "dmUserId" in data ? { dmUserId: data.dmUserId } : { streamId: data.streamId },
      })
      const streamId = stream.id

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
