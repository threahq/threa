import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { SearchService } from "./service"
import type { SearchResult } from "./repository"
import { resolveInFilterStreamIds, resolveUserAccessibleStreamIds } from "./access"
import { validateRequest } from "../../lib/validation"
import { setAuditSubjects } from "../access-log"
import { MAX_SEARCH_PHRASES, STREAM_TYPES } from "@threa/types"

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

interface Dependencies {
  pool: Pool
  searchService: SearchService
}

export function createSearchHandlers({ pool, searchService }: Dependencies) {
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
      } = data

      // `in` mixes stream ids and user ids (in:@user = the DM with that user).
      // An unresolvable filter (e.g. no DM exists) must yield zero results, not
      // fall through to an unfiltered search — the service treats an empty
      // streamIds array as "no filter".
      let resolvedInStreamIds: string[] | undefined
      if (inStreams && inStreams.length > 0) {
        resolvedInStreamIds = await resolveInFilterStreamIds(pool, workspaceId, userId, inStreams)
        if (resolvedInStreamIds.length === 0) {
          res.json({ results: [], excludedE2eStreamCount: 0 })
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
      const accessibleStreamIds = await resolveUserAccessibleStreamIds(pool, workspaceId, userId, filters)

      const { results, excludedE2eStreamCount } = await searchService.search({
        workspaceId,
        permissions: { accessibleStreamIds },
        query,
        phrases,
        filters,
        exact,
        limit,
      })

      setAuditSubjects(
        res,
        results.map((r) => ({ type: "message", id: r.id }))
      )

      res.json({
        results: results.map(serializeSearchResult),
        excludedE2eStreamCount,
      })
    },
  }
}
