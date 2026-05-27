import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { SearchService } from "./service"
import type { SearchResult } from "./repository"
import { resolveUserAccessibleStreamIds } from "./access"
import { STREAM_TYPES } from "@threa/types"

const ARCHIVE_STATUSES = ["active", "archived"] as const

const searchQuerySchema = z.object({
  query: z.string().optional().default(""),
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
    /**
     * Search messages across accessible streams.
     *
     * POST /api/workspaces/:workspaceId/search
     *
     * Body:
     * - query: string (optional) - text search terms
     * - from: string (optional) - filter by author ID
     * - with: string[] (optional) - filter to streams where these users/personas participated
     * - in: string[] (optional) - filter to specific stream IDs
     * - type: StreamType[] (optional) - filter by stream type
     * - status: ("active" | "archived")[] (optional) - filter by archive status
     * - before: ISO datetime (optional) - messages before date
     * - after: ISO datetime (optional) - messages after date
     * - limit: number (optional) - max results (1-100)
     */
    async search(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = searchQuerySchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const {
        query,
        from,
        with: withParticipants,
        in: inStreams,
        type,
        status,
        before,
        after,
        exact,
        limit,
      } = result.data

      const filters = {
        authorId: from,
        userIds: withParticipants,
        streamIds: inStreams,
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
        filters,
        exact,
        limit,
      })

      res.json({
        results: results.map(serializeSearchResult),
        excludedE2eStreamCount,
      })
    },
  }
}
