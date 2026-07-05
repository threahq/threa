import { z } from "zod"
import type { Request, Response } from "express"
import type { ConversationService } from "./service"
import type { BoardExclusionService } from "./board-exclusion-service"
import type { StreamService } from "../streams"
import type { FeatureFlagService } from "../feature-flags"
import {
  CONVERSATION_STATUSES,
  ConversationStatuses,
  MAX_CONVERSATION_TOPIC_LENGTH,
  BOARD_LENSES,
  BOARD_SCOPE_STREAM_TYPES,
  MAX_BOARD_SCOPE_STREAMS,
  MAX_BOARD_SCOPE_LABELS,
} from "@threa/types"
import { validateRequest } from "../../lib/validation"
import { HttpError } from "../../lib/errors"

const listConversationsSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

/** Comma-separated id list, capped so a hand-built URL can't splice an
 *  unbounded ANY() array into the feed query (INV-11 on the empty case). */
function csvIdListSchema(max: number, noun: string) {
  return z
    .string()
    .min(1)
    .transform((value) => value.split(",").filter((id) => id.length > 0))
    .refine((ids) => ids.length > 0 && ids.length <= max, {
      message: `${noun} must name 1-${max} ids`,
    })
}

// Root-stream TYPE list (comma-separated). Fails loudly (INV-11) on a type
// outside the board's root grains rather than silently matching nothing.
const csvTypeListSchema = z
  .string()
  .min(1)
  .transform((value) => value.split(",").filter((t) => t.length > 0))
  .refine((types) => types.length > 0 && types.every((t) => BOARD_SCOPE_STREAM_TYPES.includes(t as never)), {
    message: `types must be a comma-separated subset of: ${BOARD_SCOPE_STREAM_TYPES.join(", ")}`,
  })

// The board feed adds keyset pagination (`cursor` is an opaque `"<iso>|<id>"`
// minted by a prior page's `nextCursor`), a structural `lens` filter, and the
// include/exclude filter axes: `streams` scope + `excludeStreams` veto (the repo
// matches scope by effective root, veto by anchor-or-root), `types` +
// `excludeTypes` (root-stream grains), and `labels` + `excludeLabels` (the
// viewer's own label assignments on the anchor/root stream).
const listWorkspaceConversationsSchema = listConversationsSchema.extend({
  lens: z.enum(BOARD_LENSES).optional(),
  streams: csvIdListSchema(MAX_BOARD_SCOPE_STREAMS, "streams").optional(),
  excludeStreams: csvIdListSchema(MAX_BOARD_SCOPE_STREAMS, "excludeStreams").optional(),
  types: csvTypeListSchema.optional(),
  excludeTypes: csvTypeListSchema.optional(),
  labels: csvIdListSchema(MAX_BOARD_SCOPE_LABELS, "labels").optional(),
  excludeLabels: csvIdListSchema(MAX_BOARD_SCOPE_LABELS, "excludeLabels").optional(),
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

const updateConversationParamsSchema = z.object({
  conversationId: z.string().min(1),
})

// Status is restricted to the two the user can set — reopen (`active`) or resolve
// (`resolved`). `stalled` is a derived/LLM lifecycle state, never user-assignable.
const updateConversationBodySchema = z
  .object({
    topicSummary: z.string().trim().min(1).max(MAX_CONVERSATION_TOPIC_LENGTH).optional(),
    status: z.enum([ConversationStatuses.ACTIVE, ConversationStatuses.RESOLVED]).optional(),
  })
  .refine((body) => body.topicSummary !== undefined || body.status !== undefined, {
    message: "Provide topicSummary or status",
  })

const hideConversationParamsSchema = z.object({ conversationId: z.string().min(1) })
const muteStreamParamsSchema = z.object({ streamId: z.string().min(1) })

interface Dependencies {
  conversationService: ConversationService
  boardExclusionService: BoardExclusionService
  streamService: StreamService
  featureFlagService: FeatureFlagService
}

export function createConversationHandlers({
  conversationService,
  boardExclusionService,
  streamService,
  featureFlagService,
}: Dependencies) {
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
        scopeStreamIds: query.streams,
        scopeStreamTypes: query.types,
        excludeStreamIds: query.excludeStreams,
        excludeStreamTypes: query.excludeTypes,
        scopeLabelIds: query.labels,
        excludeLabelIds: query.excludeLabels,
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

      const post = await conversationService.getBoardPostById(workspaceId, conversationId, userId)
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
     * User edit of a conversation from the board card / panel: rename the topic
     * and/or mark it resolved/reopened. Ungated (like reassign/read/unread — only
     * the board *read* endpoints gate on the flag). Access via the conversation's
     * root stream (INV-62).
     */
    async updateConversation(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const { conversationId } = validateRequest(updateConversationParamsSchema, req.params)
      const { topicSummary, status } = validateRequest(updateConversationBodySchema, req.body)

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const result = await conversationService.updateConversation({ workspaceId, conversationId, topicSummary, status })
      res.json(result)
    },

    /**
     * Per-viewer board exclusions (board-view-design.md § "Hide & mute"). All are
     * board-flag-gated (404 without `board-view`, like the feed). Hide/unhide gate
     * on the conversation's root-stream access (INV-62); mute/unmute on the target
     * stream.
     */
    async hideConversation(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      if ((await featureFlagService.getFlag(workspaceId, userId, "board-view")) !== "on") {
        throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
      }
      const { conversationId } = validateRequest(hideConversationParamsSchema, req.params)
      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)
      const result = await boardExclusionService.hideConversation({ workspaceId, conversationId, userId })
      res.json(result)
    },

    async unhideConversation(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      if ((await featureFlagService.getFlag(workspaceId, userId, "board-view")) !== "on") {
        throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
      }
      const { conversationId } = validateRequest(hideConversationParamsSchema, req.params)
      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)
      await boardExclusionService.unhideConversation({ workspaceId, conversationId, userId })
      res.json({ ok: true })
    },

    async muteStream(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      if ((await featureFlagService.getFlag(workspaceId, userId, "board-view")) !== "on") {
        throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
      }
      const { streamId } = validateRequest(muteStreamParamsSchema, req.params)
      await streamService.validateStreamAccess(streamId, workspaceId, userId)
      await boardExclusionService.muteStream({ workspaceId, streamId, userId })
      res.json({ ok: true })
    },

    async unmuteStream(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      if ((await featureFlagService.getFlag(workspaceId, userId, "board-view")) !== "on") {
        throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
      }
      const { streamId } = validateRequest(muteStreamParamsSchema, req.params)
      await streamService.validateStreamAccess(streamId, workspaceId, userId)
      await boardExclusionService.unmuteStream({ workspaceId, streamId, userId })
      res.json({ ok: true })
    },

    async getBoardExclusions(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      if ((await featureFlagService.getFlag(workspaceId, userId, "board-view")) !== "on") {
        throw new HttpError("Not found", { status: 404, code: "NOT_FOUND" })
      }
      res.json(await boardExclusionService.getExclusions(workspaceId, userId))
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
