import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { KNOWLEDGE_TYPES, MEMO_TYPES } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { resolveUserAccessibleStreamIds, SearchRepository } from "../search"
import { computeAgentAccessSpec } from "../agents"
import { StreamRepository } from "../streams"
import type { MemoExplorerDetail, MemoExplorerResult, MemoExplorerService } from "./explorer-service"
import type { Memo } from "./repository"

const memoSearchSchema = z.object({
  query: z.string().optional().default(""),
  streamId: z.string().optional(),
  in: z.array(z.string()).optional(),
  memoType: z.array(z.enum(MEMO_TYPES)).optional(),
  knowledgeType: z.array(z.enum(KNOWLEDGE_TYPES)).optional(),
  tags: z.array(z.string()).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  exact: z.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

/**
 * Resolve which streams a memo search may read from.
 *
 * The memory explorer (no `streamId`) browses everything the user can access.
 * The inline `/memo` picker passes the stream being composed in, and must be
 * scoped exactly like an agent invoked there (`computeAgentAccessSpec`): a
 * private channel sees public memos + that channel, a public channel or DM sees
 * only what is shareable into it. Without this, a memo from an unrelated private
 * stream could be surfaced — and embedded as a reference — into a stream it does
 * not belong to, leaking it (or a link to it) to that stream's audience.
 */
async function resolveMemoSearchScope(
  pool: Pool,
  workspaceId: string,
  userId: string,
  streamId: string | undefined
): Promise<string[]> {
  const userAccessibleStreamIds = await resolveUserAccessibleStreamIds(pool, workspaceId, userId, {
    archiveStatus: ["active", "archived"],
  })

  if (!streamId) {
    return userAccessibleStreamIds
  }

  const stream = await StreamRepository.findById(pool, streamId)
  if (!stream || stream.workspaceId !== workspaceId) {
    throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
  }

  const accessSpec = await computeAgentAccessSpec(pool, { stream, invokingUserId: userId })
  const scopedStreamIds = await SearchRepository.getAccessibleStreamsForAgent(pool, accessSpec, workspaceId, {
    archiveStatus: ["active", "archived"],
  })

  // The access spec is derived from stream type/visibility, not membership, so
  // intersect with the user's own access: the scoped result can never exceed
  // what the user could already see, even if they pass a stream they aren't in.
  const userAccessibleSet = new Set(userAccessibleStreamIds)
  return scopedStreamIds.filter((id) => userAccessibleSet.has(id))
}

function normalizeSearchMode(query: string, exact?: boolean): { query: string; exact: boolean } {
  const trimmed = query.trim()
  if (exact) {
    return { query: trimmed, exact: trimmed.length > 0 }
  }

  const isQuoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
  if (!isQuoted) {
    return { query: trimmed, exact: false }
  }

  const unquoted = trimmed.slice(1, -1).trim()
  return { query: unquoted, exact: unquoted.length > 0 }
}

function serializeMemo(memo: Memo) {
  return {
    ...memo,
    createdAt: memo.createdAt.toISOString(),
    updatedAt: memo.updatedAt.toISOString(),
    archivedAt: memo.archivedAt?.toISOString() ?? null,
  }
}

function serializeMemoResult(result: MemoExplorerResult) {
  return {
    memo: serializeMemo(result.memo),
    distance: result.distance,
    sourceStream: result.sourceStream,
    rootStream: result.rootStream,
  }
}

function serializeMemoDetail(detail: MemoExplorerDetail) {
  return {
    ...serializeMemoResult(detail),
    sourceMessages: detail.sourceMessages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
  }
}

interface Dependencies {
  pool: Pool
  memoExplorerService: MemoExplorerService
}

export function createMemoHandlers({ pool, memoExplorerService }: Dependencies) {
  return {
    async search(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const result = memoSearchSchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid search request", { status: 400, code: "VALIDATION_ERROR" })
      }

      const { query, exact, streamId, in: inStreams, memoType, knowledgeType, tags, before, after, limit } = result.data
      const normalized = normalizeSearchMode(query, exact)

      const accessibleStreamIds = await resolveMemoSearchScope(pool, workspaceId, userId, streamId)

      const results = await memoExplorerService.search({
        workspaceId,
        permissions: { accessibleStreamIds },
        query: normalized.query,
        exact: normalized.exact,
        filters: {
          streamIds: inStreams,
          memoTypes: memoType,
          knowledgeTypes: knowledgeType,
          tags,
          before: before ? new Date(before) : undefined,
          after: after ? new Date(after) : undefined,
        },
        limit,
      })

      res.json({ results: results.map(serializeMemoResult) })
    },

    async getById(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const memoId = z.string().min(1).parse(req.params.memoId)

      const accessibleStreamIds = await resolveUserAccessibleStreamIds(pool, workspaceId, userId, {
        archiveStatus: ["active", "archived"],
      })

      const memo = await memoExplorerService.getById(workspaceId, memoId, {
        accessibleStreamIds,
      })

      if (!memo) {
        throw new HttpError("Memo not found", { status: 404, code: "NOT_FOUND" })
      }

      res.json({ memo: serializeMemoDetail(memo) })
    },
  }
}
