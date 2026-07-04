import { z } from "zod"
import type { Request, Response } from "express"
import type { ConversationService } from "./service"
import type { StreamService } from "../streams"
import type { FeatureFlagService } from "../feature-flags"
import { CONVERSATION_STATUSES, BOARD_LENSES } from "@threa/types"
import { validateRequest } from "../../lib/validation"
import { HttpError } from "../../lib/errors"

const listConversationsSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

// The board feed adds keyset pagination (`cursor` is an opaque `"<iso>|<id>"`
// minted by a prior page's `nextCursor`) and a structural `lens` filter.
const listWorkspaceConversationsSchema = listConversationsSchema.extend({
  lens: z.enum(BOARD_LENSES).optional(),
  cursor: z.string().min(1).optional(),
})

// Parse the opaque cursor, failing loudly (INV-11/32) on a malformed value
// rather than silently restarting at page 1.
function decodeBoardCursor(cursor: string | undefined): { lastActivityAt: string; id: string } | undefined {
  if (!cursor) return undefined
  const sep = cursor.indexOf("|")
  const lastActivityAt = sep === -1 ? "" : cursor.slice(0, sep)
  const id = sep === -1 ? "" : cursor.slice(sep + 1)
  if (!lastActivityAt || !id || Number.isNaN(Date.parse(lastActivityAt))) {
    throw new HttpError("Invalid board cursor", { status: 400, code: "INVALID_CURSOR" })
  }
  return { lastActivityAt, id }
}

const reassignMessageParamsSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
})

const markReadSchema = z.object({
  throughMessageId: z.string().min(1),
})

const markUnreadSchema = z.object({
  fromMessageId: z.string().min(1),
})

interface Dependencies {
  conversationService: ConversationService
  streamService: StreamService
  featureFlagService: FeatureFlagService
}

export function createConversationHandlers({ conversationService, streamService, featureFlagService }: Dependencies) {
  return {
    /**
     * Cross-stream board feed. Access is enforced inside the query (INV-62), so
     * there's no single stream to validate here — unlike {@link listByStream}.
     * Gated behind the `board-view` feature flag: a viewer without it gets a 404,
     * so the board isn't reachable even by hitting the endpoint directly.
     */
    async listByWorkspace(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const boardFlag = await featureFlagService.getFlag(workspaceId, userId, "board-view")
      if (boardFlag !== "on") {
        throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
      }

      const query = validateRequest(listWorkspaceConversationsSchema, req.query)

      const result = await conversationService.listByWorkspace(workspaceId, userId, {
        status: query.status,
        lens: query.lens,
        limit: query.limit,
        cursor: decodeBoardCursor(query.cursor),
      })
      res.json(result)
    },

    async listByStream(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const query = validateRequest(listConversationsSchema, req.query)

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const conversations = await conversationService.listByStream(streamId, query)
      res.json({ conversations })
    },

    async getById(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      res.json({ conversation })
    },

    async getMessages(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const messages = await conversationService.getMessages(conversationId)
      res.json({ messages })
    },

    /**
     * The board card's "N more" expand: the full conversation as enriched board
     * post messages (attachments + link previews), so revealed middle messages
     * read like the rest of the post. Board-gated (404 without the flag), same
     * as the workspace feed.
     */
    async getBoardMessages(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

      const boardFlag = await featureFlagService.getFlag(workspaceId, userId, "board-view")
      if (boardFlag !== "on") {
        throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
      }

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const messages = await conversationService.getBoardMessages(workspaceId, conversationId)
      res.json({ messages })
    },

    /**
     * The board post for a single conversation — backs the conversation side
     * panel (Mechanism B, board-view-design.md), which renders the same projection
     * a board card does but reachable by id (a board-card expand or an /s/:id
     * deep-link, where the board feed never seeded the post). Board-gated (404
     * without the flag), same access as {@link getBoardMessages}.
     */
    async getBoardPost(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

      const boardFlag = await featureFlagService.getFlag(workspaceId, userId, "board-view")
      if (boardFlag !== "on") {
        throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
      }

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const post = await conversationService.getBoardPostById(workspaceId, conversationId)
      if (!post) {
        return res.status(404).json({ error: "Conversation not found" })
      }
      res.json({ post })
    },

    /**
     * User correction from the timeline conversation overlay: make
     * `conversationId` the message's primary conversation. Applies the move
     * and records it as boundary-extraction feedback.
     */
    async reassignMessage(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const { conversationId, messageId } = validateRequest(reassignMessageParamsSchema, req.params)

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const result = await conversationService.reassignMessage({ workspaceId, conversationId, messageId, userId })
      res.json(result)
    },

    /**
     * Mark a conversation read through a message (inclusive). Applies a sparse
     * read overlay across every stream the conversation spans; returns the
     * per-stream absolute read-state snapshots. Access via the conversation's root
     * stream (INV-62), matching the other conversation reads.
     */
    async markRead(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

      const { throughMessageId } = validateRequest(markReadSchema, req.body)

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const result = await conversationService.markRead({ workspaceId, conversationId, throughMessageId, userId })
      res.json(result)
    },

    /** Mark a conversation unread from a message (inclusive). Inverse of {@link markRead}. */
    async markUnread(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

      const { fromMessageId } = validateRequest(markUnreadSchema, req.body)

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const result = await conversationService.markUnread({ workspaceId, conversationId, fromMessageId, userId })
      res.json(result)
    },
  }
}
