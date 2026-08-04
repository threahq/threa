import type { Pool } from "pg"
import {
  CONTEXT_CATEGORIES,
  type ContextCategory,
  type ListStreamContextOccurrencesResponse,
  type ListStreamContextResponse,
  type StreamContextItem,
  type StreamContextScope,
} from "@threa/types"
import { HttpError } from "../../lib/errors"
import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor"
import { E2eStreamsRepository } from "../e2e-streams"
import { checkStreamAccess } from "../streams"
import { StreamContextReadRepository, type StreamContextFeedRow } from "./read-repository"

interface Dependencies {
  pool: Pool
}

export interface ListStreamContextParams {
  workspaceId: string
  userId: string
  streamId: string
  scope: StreamContextScope
  category?: ContextCategory
  categories?: ContextCategory[]
  queryText?: string
  authorId?: string
  before?: Date
  after?: Date
  cursor?: string
  limit: number
}

export interface ListStreamContextOccurrencesParams {
  workspaceId: string
  userId: string
  streamId: string
  scope: StreamContextScope
  category: ContextCategory
  groupKey: string
  queryText?: string
  authorId?: string
  before?: Date
  after?: Date
  cursor?: string
  limit: number
}

const ZERO_COUNTS = (): Record<ContextCategory, number> =>
  Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, 0])) as Record<ContextCategory, number>

function toItem(row: StreamContextFeedRow): StreamContextItem {
  const { cursorOccurredAtKey: _cursorOccurredAtKey, id: _id, ...item } = row
  return item
}

function page(rows: StreamContextFeedRow[], limit: number): { items: StreamContextItem[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const visible = hasMore ? rows.slice(0, limit) : rows
  const last = visible[visible.length - 1]
  return {
    items: visible.map(toItem),
    nextCursor: hasMore && last ? encodeKeysetCursor({ at: last.cursorOccurredAtKey, id: last.id }) : null,
  }
}

/**
 * Read side of the "in this stream" index. Access is resolved once per request
 * through {@link checkStreamAccess} and the query then runs against the root it
 * resolved (INV-62) — never against `stream_members`, so a thread the caller is
 * not a member of still shows up under its readable root.
 */
export function createStreamContextService({ pool }: Dependencies) {
  async function resolveScope(params: { workspaceId: string; userId: string; streamId: string }) {
    const stream = await checkStreamAccess(pool, params.streamId, params.workspaceId, params.userId)
    if (!stream) {
      throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })
    }
    const rootStreamId = stream.rootStreamId ?? stream.id
    const sealed = await E2eStreamsRepository.isE2eStream(pool, params.workspaceId, rootStreamId)
    return { rootStreamId, sealed }
  }

  return {
    async list(params: ListStreamContextParams): Promise<ListStreamContextResponse> {
      const { rootStreamId, sealed } = await resolveScope(params)
      const cursor = decodeKeysetCursor(params.cursor)

      // A sealed stream holds only ciphertext, so the index is empty by
      // construction — the panel derives locally instead of paging nothing.
      if (sealed) {
        return { items: [], counts: ZERO_COUNTS(), nextCursor: null, mode: "client" }
      }

      const filters = {
        workspaceId: params.workspaceId,
        rootStreamId,
        streamId: params.streamId,
        scope: params.scope,
        category: params.category,
        categories: params.categories,
        queryText: params.queryText,
        authorId: params.authorId,
        before: params.before,
        after: params.after,
      }

      const rows = await StreamContextReadRepository.listFeed(pool, { ...filters, cursor, limit: params.limit + 1 })
      // Counts are per-chip totals for the whole scope, so the category
      // selector must not narrow them — every other chip would read 0.
      const counts = cursor
        ? null
        : await StreamContextReadRepository.countsByCategory(pool, {
            ...filters,
            category: undefined,
            categories: undefined,
          })
      return { ...page(rows, params.limit), counts, mode: "index" }
    },

    async listOccurrences(params: ListStreamContextOccurrencesParams): Promise<ListStreamContextOccurrencesResponse> {
      const { rootStreamId, sealed } = await resolveScope(params)
      const cursor = decodeKeysetCursor(params.cursor)

      if (sealed) {
        return { items: [], nextCursor: null }
      }

      const rows = await StreamContextReadRepository.listOccurrences(pool, {
        workspaceId: params.workspaceId,
        rootStreamId,
        streamId: params.streamId,
        scope: params.scope,
        category: params.category,
        groupKey: params.groupKey,
        queryText: params.queryText,
        authorId: params.authorId,
        before: params.before,
        after: params.after,
        cursor,
        limit: params.limit + 1,
      })
      return page(rows, params.limit)
    },
  }
}

export type StreamContextService = ReturnType<typeof createStreamContextService>
