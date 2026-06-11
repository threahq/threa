import { z } from "zod"
import type { Request, Response } from "express"
import type { ConversationService } from "./service"
import type { StreamService } from "../streams"
import { CONVERSATION_STATUSES } from "@threa/types"

const listConversationsSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

const reassignMessageParamsSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
})

interface Dependencies {
  conversationService: ConversationService
  streamService: StreamService
}

export function createConversationHandlers({ conversationService, streamService }: Dependencies) {
  return {
    async listByStream(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = req.params

      const result = listConversationsSchema.safeParse(req.query)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const conversations = await conversationService.listByStream(streamId, result.data)
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
     * User correction from the timeline conversation overlay: make
     * `conversationId` the message's primary conversation. Applies the move
     * and records it as boundary-extraction feedback.
     */
    async reassignMessage(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const paramsResult = reassignMessageParamsSchema.safeParse(req.params)
      if (!paramsResult.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(paramsResult.error).fieldErrors,
        })
      }
      const { conversationId, messageId } = paramsResult.data

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const result = await conversationService.reassignMessage({ workspaceId, conversationId, messageId, userId })
      res.json(result)
    },
  }
}
