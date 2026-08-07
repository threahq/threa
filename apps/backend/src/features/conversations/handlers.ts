import { z } from "zod"
import type { Request, Response } from "express"
import type { ConversationService } from "./service"
import type { BoundaryExtractionService } from "./boundary-extraction-service"
import type { BoardExclusionService } from "./board-exclusion-service"
import type { StreamService } from "../streams"
import { setAuditSubjects } from "../access-log"
import {
  CONVERSATION_STATUSES,
  ConversationStatuses,
  StreamTypes,
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
  // A retired lens degrades to "no lens condition" instead of a 400: the
  // frontend deploys before the backend and SW-cached bundles linger, so old
  // bundles still send retired values and must get the board, not an error.
  lens: z
    .string()
    .optional()
    .transform((value) =>
      value !== undefined && (BOARD_LENSES as readonly string[]).includes(value)
        ? (value as (typeof BOARD_LENSES)[number])
        : undefined
    ),
  streams: csvIdListSchema(MAX_BOARD_SCOPE_STREAMS, "streams").optional(),
  excludeStreams: csvIdListSchema(MAX_BOARD_SCOPE_STREAMS, "excludeStreams").optional(),
  types: csvTypeListSchema.optional(),
  excludeTypes: csvTypeListSchema.optional(),
  labels: csvIdListSchema(MAX_BOARD_SCOPE_LABELS, "labels").optional(),
  excludeLabels: csvIdListSchema(MAX_BOARD_SCOPE_LABELS, "excludeLabels").optional(),
  // `?archived=true` opts into archived cards; absent = the board's default
  // (hide archived), which the service reads as `?? false`. Kept
  // undefined-when-absent (not coerced to `false`) so the options object stays
  // uniform with the other optional axes.
  archived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
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

const settleMessageParamsSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
})

const splitThreadSchema = z.object({
  threadStreamId: z.string().min(1),
})

// Batch reassignment of hand-picked messages to another conversation. A present
// `targetConversationId` reassigns into that existing conversation; absent/null
// mints a new one (the "split into its own topic" gesture). Capped at 100, like
// the message-move flow, so a hand-built request can't splice an unbounded set.
const reassignMessagesSchema = z.object({
  streamId: z.string().min(1),
  messageIds: z.array(z.string().min(1)).min(1).max(100),
  targetConversationId: z.string().min(1).nullish(),
})

const proposeSplitParamsSchema = z.object({
  conversationId: z.string().min(1),
})

// Apply a user-confirmed AI split: ≥2 groups partitioning the conversation's
// messages. `groups[0]` is kept in the source (re-titled); the rest are minted.
// Every message id appears in exactly one group; total capped like the move flow.
const applySplitParamsSchema = z.object({
  conversationId: z.string().min(1),
})
const applySplitSchema = z
  .object({
    groups: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(MAX_CONVERSATION_TOPIC_LENGTH),
          summary: z.string().trim().min(1).optional(),
          messageIds: z.array(z.string().min(1)).min(1),
        })
      )
      .min(2)
      .max(50),
  })
  .superRefine((body, ctx) => {
    const all = body.groups.flatMap((g) => g.messageIds)
    if (all.length > 500) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "groups name at most 500 messages in total" })
    }
    if (new Set(all).size !== all.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "each message may appear in only one group" })
    }
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
const regenerateConversationParamsSchema = z
  .object({ workspaceId: z.string().min(1), conversationId: z.string().min(1) })
  .strict()
const regenerateConversationBodySchema = z.object({}).strict()

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
  boundaryExtractionService: BoundaryExtractionService
  boardExclusionService: BoardExclusionService
  streamService: StreamService
}

export function createConversationHandlers({
  conversationService,
  boundaryExtractionService,
  boardExclusionService,
  streamService,
}: Dependencies) {
  return {
    /**
     * Cross-stream board feed. Access is enforced inside the query (INV-62), so
     * there's no single stream to validate here — unlike {@link listByStream}.
     */
    async listByWorkspace(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

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
        showArchived: query.archived,
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

      setAuditSubjects(res, [
        { type: "conversation", id: conversationId },
        { type: "stream", id: conversation.streamId },
      ])
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
      setAuditSubjects(res, [
        { type: "conversation", id: conversationId },
        { type: "stream", id: conversation.streamId },
      ])
      res.json({ messages })
    },

    /**
     * The board card's "N more" expand: the full conversation as enriched board
     * post messages (attachments + link previews), so revealed middle messages
     * read like the rest of the post.
     */
    async getBoardMessages(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const messages = await conversationService.getBoardMessages(workspaceId, conversationId)
      setAuditSubjects(res, [
        { type: "conversation", id: conversationId },
        { type: "stream", id: conversation.streamId },
      ])
      res.json({ messages })
    },

    /**
     * The board post for a single conversation — backs the conversation side
     * panel (Mechanism B, board-view-design.md), which renders the same projection
     * a board card does but reachable by id (a board-card expand or an /s/:id
     * deep-link, where the board feed never seeded the post). Same access as
     * {@link getBoardMessages}.
     */
    async getBoardPost(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

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
      setAuditSubjects(res, [
        { type: "conversation", id: conversationId },
        { type: "stream", id: conversation.streamId },
      ])
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
     * "Keep here": the user confirms a provisionally-placed message belongs in
     * this conversation. Same access posture as {@link reassignMessage} —
     * workspace-scoped conversation lookup, then stream access resolved through
     * the thread root (INV-62).
     */
    async settleMessage(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const { conversationId, messageId } = validateRequest(settleMessageParamsSchema, req.params)

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const result = await conversationService.settleMessage({ workspaceId, conversationId, messageId, userId })
      res.json(result)
    },

    /**
     * User correction from the timeline conversation overlay: reassign a set of
     * selected messages to another conversation — an existing one
     * (`targetConversationId`) or a freshly minted one (absent → the split
     * gesture). Access gates on the source stream (the messages' home, and the
     * mint's anchor); the service pins an existing target to that same stream.
     */
    async reassignMessages(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const { streamId, messageIds, targetConversationId } = validateRequest(reassignMessagesSchema, req.body)

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(streamId, workspaceId, userId)

      const target = targetConversationId
        ? { kind: "existing" as const, conversationId: targetConversationId }
        : { kind: "new" as const }

      const result = await conversationService.reassignMessagesToConversation({
        workspaceId,
        streamId,
        messageIds,
        target,
        actorUserId: userId,
      })
      res.json(result)
    },

    /**
     * Ask the clustering model how a conversation should be split into smaller
     * topics. Read-only — returns a proposal the client renders for confirmation;
     * nothing is written until {@link applySplit}. A single-group proposal means
     * "no split suggested". Access gates on the conversation's root stream (INV-62).
     */
    async proposeSplit(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const { conversationId } = validateRequest(proposeSplitParamsSchema, req.params)

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      const stream = await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)
      if (stream.type === StreamTypes.SCRATCHPAD) {
        throw new HttpError("Scratchpad conversations cannot be split", {
          status: 400,
          code: "SCRATCHPAD_CONVERSATION_TITLE_OWNED_BY_STREAM",
        })
      }

      const proposal = await boundaryExtractionService.proposeSplit(conversationId, workspaceId)
      res.json(proposal)
    },

    /**
     * Apply a user-confirmed split proposal: keep the first group in the source
     * conversation (re-titled) and mint the rest as new titled conversations. The
     * source stream is derived from the conversation itself (the mint anchor), so
     * the body carries only the confirmed groups. Access gates on the conversation's
     * root stream (INV-62), like {@link reassignMessage}.
     */
    async applySplit(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const { conversationId } = validateRequest(applySplitParamsSchema, req.params)
      const { groups } = validateRequest(applySplitSchema, req.body)

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const result = await conversationService.applySplit({
        workspaceId,
        streamId: conversation.streamId,
        conversationId,
        groups,
        actorUserId: userId,
      })
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

      const result = await conversationService.updateConversation({
        workspaceId,
        conversationId,
        topicSummary,
        status,
        actorUserId: userId,
      })
      res.json(result)
    },

    async regenerateTitle(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = validateRequest(regenerateConversationParamsSchema, req.params)
      validateRequest(regenerateConversationBodySchema, req.body ?? {})
      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)
      res.json(await conversationService.regenerateTitle({ workspaceId, conversationId }))
    },

    /**
     * Split a soft thread out of its conversation into its own topic: move the
     * thread's member messages (and any deeper sub-topics') to a freshly minted
     * conversation anchored to the thread, recording each move as boundary
     * feedback. Gated by the source conversation's single root (INV-62), matching
     * {@link reassignMessage}.
     */
    async splitThread(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { conversationId } = req.params

      const { threadStreamId } = validateRequest(splitThreadSchema, req.body)

      const conversation = await conversationService.getById(conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return res.status(404).json({ error: "Conversation not found" })
      }

      // validateStreamAccess handles public visibility + thread root membership
      await streamService.validateStreamAccess(conversation.streamId, workspaceId, userId)

      const result = await conversationService.splitThreadIntoConversation({
        workspaceId,
        conversationId,
        threadStreamId,
        actorUserId: userId,
      })
      res.json(result)
    },

    /**
     * Per-viewer board exclusions (board-view-design.md § "Hide & mute").
     * Hide/unhide gate on the conversation's root-stream access (INV-62);
     * mute/unmute on the target stream.
     */
    async hideConversation(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
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
      const { streamId } = validateRequest(muteStreamParamsSchema, req.params)
      await streamService.validateStreamAccess(streamId, workspaceId, userId)
      await boardExclusionService.muteStream({ workspaceId, streamId, userId })
      res.json({ ok: true })
    },

    async unmuteStream(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const { streamId } = validateRequest(muteStreamParamsSchema, req.params)
      await streamService.validateStreamAccess(streamId, workspaceId, userId)
      await boardExclusionService.unmuteStream({ workspaceId, streamId, userId })
      res.json({ ok: true })
    },

    async getBoardExclusions(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
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
