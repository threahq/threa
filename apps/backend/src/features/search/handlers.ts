import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { SearchService } from "./service"
import type { SearchQueryLogService } from "./query-log-service"
import type { FeatureFlagService } from "../feature-flags"
import type { ConversationForMessage, SearchResult } from "./repository"
import type { SearchCluster } from "./clusters"
import { serializeMemoResult } from "../memos"
import { resolveInFilterStreamIds, resolveUserAccessibleStreamIds } from "./access"
import { searchRankingForFlag } from "./config"
import { logger } from "../../lib/logger"
import { validateRequest } from "../../lib/validation"
import { setAuditSubjects } from "../access-log"
import { MAX_SEARCH_PHRASES, SEARCH_CLICK_KINDS, STREAM_TYPES } from "@threa/types"

const ARCHIVE_STATUSES = ["active", "archived"] as const

export const searchQuerySchema = z.object({
  query: z.string().optional().default(""),
  phrases: z.array(z.string().min(1)).max(MAX_SEARCH_PHRASES).optional(),
  from: z.string().optional(), // Single author ID
  with: z.array(z.string()).optional(), // User or persona IDs (AND logic)
  in: z.array(z.string()).optional(), // Stream IDs
  type: z.array(z.enum(STREAM_TYPES)).optional(), // Stream types (OR logic)
  status: z.array(z.enum(ARCHIVE_STATUSES)).optional(), // Archive status (active, archived)
  before: z.string().datetime().optional(), // Exclusive (<)
  after: z.string().datetime().optional(), // Inclusive (>=)
  exact: z.boolean().optional(), // Use ILIKE substring matching instead of full-text
  limit: z.coerce.number().int().min(1).max(100).optional(),
  deep: z.boolean().optional(), // Rewrite into alternative phrasings, fuse, and rerank
})

export const searchClickSchema = z.object({
  kind: z.enum(SEARCH_CLICK_KINDS),
  id: z.string().min(1),
})

const searchClickParamsSchema = z.object({
  id: z.string().min(1),
})

export function serializeSearchResult(result: SearchResult) {
  return {
    id: result.id,
    streamId: result.streamId,
    sequence: result.sequence.toString(),
    content: result.content,
    authorId: result.authorId,
    authorType: result.authorType,
    replyCount: result.replyCount,
    // Always include metadata (empty object when unset) to match other message responses.
    metadata: result.metadata ?? {},
    ...(result.editedAt != null && { editedAt: result.editedAt.toISOString() }),
    createdAt: result.createdAt.toISOString(),
    rank: result.rank,
  }
}

export function serializeConversationForMessage(result: ConversationForMessage) {
  return {
    id: result.id,
    streamId: result.streamId,
    topicSummary: result.topicSummary,
    summary: result.summary,
    status: result.status,
    messageCount: result.messageCount,
    participantIds: result.participantIds,
    firstMessageId: result.firstMessageId,
    firstMessageAt: result.firstMessageAt?.toISOString() ?? null,
    lastMessageAt: result.lastMessageAt?.toISOString() ?? null,
  }
}

export function serializeSearchCluster(cluster: SearchCluster) {
  return {
    conversation: cluster.conversation ? serializeConversationForMessage(cluster.conversation) : null,
    streamId: cluster.streamId,
    matchedVia: cluster.matchedVia,
    hits: cluster.hits.map(serializeSearchResult),
    memoIds: cluster.memoIds,
    score: cluster.score,
  }
}

interface Dependencies {
  pool: Pool
  searchService: SearchService
  searchQueryLogService: SearchQueryLogService
  featureFlagService: FeatureFlagService
}

export function createSearchHandlers({ pool, searchService, searchQueryLogService, featureFlagService }: Dependencies) {
  return {
    async search(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const data = validateRequest(searchQuerySchema, req.body)

      const {
        query,
        phrases,
        from,
        with: withParticipants,
        in: inStreams,
        type,
        status,
        before,
        after,
        exact,
        limit,
        deep,
      } = data

      // `in` mixes stream ids and user ids (in:@user = the DM with that user).
      // An unresolvable filter (e.g. no DM exists) must yield zero results, not
      // fall through to an unfiltered search — the service treats an empty
      // streamIds array as "no filter".
      let resolvedInStreamIds: string[] | undefined
      if (inStreams && inStreams.length > 0) {
        resolvedInStreamIds = await resolveInFilterStreamIds(pool, workspaceId, userId, inStreams)
        if (resolvedInStreamIds.length === 0) {
          res.json({
            results: [],
            clusters: [],
            memos: [],
            excludedE2eStreamCount: 0,
            queryLogId: null,
          })
          return
        }
      }

      const filters = {
        authorId: from,
        userIds: withParticipants,
        streamIds: resolvedInStreamIds,
        streamTypes: type,
        archiveStatus: status,
        before: before ? new Date(before) : undefined,
        after: after ? new Date(after) : undefined,
      }

      // Resolve access before calling the auth-agnostic search service
      const [accessibleStreamIds, flags] = await Promise.all([
        resolveUserAccessibleStreamIds(pool, workspaceId, userId, filters),
        featureFlagService.getFlags(workspaceId, req.user!.workosUserId),
      ])
      const searchFlag = flags.search

      const { results, conversations, memos, clusters, excludedE2eStreamCount } = await searchService.searchClusters({
        workspaceId,
        permissions: { accessibleStreamIds, userId },
        query,
        phrases,
        filters,
        exact,
        limit,
        deep,
        searchFlag,
      })

      setAuditSubjects(res, [
        ...results.map((r) => ({ type: "message", id: r.id })),
        ...conversations.map((c) => ({ type: "conversation", id: c.id })),
        ...memos.map((m) => ({ type: "memo", id: m.memo.id })),
      ])

      // Consent is the user's or workspace's flag, resolved here, never sent by the client.
      let queryLogId: string | null = null
      if (flags.searchQueryLog === "on") {
        try {
          queryLogId = (
            await searchQueryLogService.record({
              workspaceId,
              userId,
              query,
              params: {
                phrases,
                from,
                with: withParticipants,
                in: inStreams,
                type,
                status,
                before,
                after,
                exact,
                limit,
              },
              mode: deep ? "deep" : "normal",
              ranking: searchRankingForFlag(searchFlag),
              resultIds: {
                messages: results.map((r) => r.id),
                conversations: [...new Set(clusters.flatMap((c) => (c.conversation ? [c.conversation.id] : [])))],
                memos: memos.map((m) => m.memo.id),
              },
            })
          ).id
        } catch (err) {
          // The log is a side channel: the search already succeeded, so a failed write must not take it down.
          logger.error({ err, workspaceId, userId }, "Failed to record search query log")
        }
      }

      res.json({
        results: results.map(serializeSearchResult),
        clusters: clusters.map(serializeSearchCluster),
        memos: memos.map(serializeMemoResult),
        excludedE2eStreamCount,
        queryLogId,
      })
    },

    async recordClick(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { id } = validateRequest(searchClickParamsSchema, req.params)
      const { kind, id: targetId } = validateRequest(searchClickSchema, req.body)

      // Consent is re-checked per click: a log id from before the flag was
      // switched off must not keep writing behavioural data.
      const flags = await featureFlagService.getFlags(workspaceId, req.user!.workosUserId)
      if (flags.searchQueryLog !== "on") {
        res.status(204).end()
        return
      }

      await searchQueryLogService.recordClick({ workspaceId, userId, id, kind, targetId })
      setAuditSubjects(res, [
        { type: "search_query_log", id },
        { type: kind, id: targetId },
      ])
      res.status(204).end()
    },
  }
}
