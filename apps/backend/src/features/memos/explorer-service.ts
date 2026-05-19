import type { Pool } from "pg"
import type { AuthorType, KnowledgeType, MemoType } from "@threa/types"
import { logger } from "../../lib/logger"
import { ConversationRepository } from "../conversations"
import { MessageRepository, type Message } from "../messaging"
import { MemoRepository, type Memo, type MemoSearchFilters } from "./repository"
import { classifyMemoQueryIntent } from "./query-intent"
import { resolveMemoSearchMode, DEFAULT_MEMO_SEARCH_MODE, MEMO_RERANKER_CANDIDATE_LIMIT } from "./config"
import type { RerankerLike } from "./reranker"
import type { EmbeddingServiceLike } from "./embedding-service"
import { StreamRepository, type Stream } from "../streams"
import { PersonaRepository } from "../agents"
import { UserRepository } from "../workspaces"

const DEFAULT_LIMIT = 30

export interface MemoExplorerFilters {
  streamIds?: string[]
  memoTypes?: MemoType[]
  knowledgeTypes?: KnowledgeType[]
  tags?: string[]
  before?: Date
  after?: Date
}

export interface MemoExplorerPermissions {
  accessibleStreamIds: string[]
}

export interface MemoExplorerSearchParams {
  workspaceId: string
  permissions: MemoExplorerPermissions
  query: string
  exact?: boolean
  filters?: MemoExplorerFilters
  limit?: number
}

export interface MemoStreamRef {
  id: string
  type: string
  name: string | null
}

export interface MemoExplorerResult {
  memo: Memo
  distance: number
  sourceStream: MemoStreamRef | null
  rootStream: MemoStreamRef | null
}

export interface MemoExplorerSourceMessage {
  id: string
  streamId: string
  streamName: string
  authorId: string
  authorType: AuthorType
  authorName: string
  content: string
  createdAt: Date
}

export interface MemoExplorerDetail extends MemoExplorerResult {
  sourceMessages: MemoExplorerSourceMessage[]
}

export interface MemoExplorerServiceDeps {
  pool: Pool
  embeddingService: EmbeddingServiceLike
  reranker: RerankerLike
}

export class MemoExplorerService {
  private readonly pool: Pool
  private readonly embeddingService: EmbeddingServiceLike
  private readonly reranker: RerankerLike

  constructor(deps: MemoExplorerServiceDeps) {
    this.pool = deps.pool
    this.embeddingService = deps.embeddingService
    this.reranker = deps.reranker
  }

  async search(params: MemoExplorerSearchParams): Promise<MemoExplorerResult[]> {
    const { workspaceId, permissions, query, exact = false, filters = {}, limit = DEFAULT_LIMIT } = params

    const streamIds = this.resolveStreamIds(permissions.accessibleStreamIds, filters.streamIds)
    if (streamIds.length === 0) {
      return []
    }

    const repoFilters: MemoSearchFilters = {
      streamIds,
      memoTypes: filters.memoTypes,
      knowledgeTypes: filters.knowledgeTypes,
      tags: filters.tags,
      before: filters.before,
      after: filters.after,
    }

    if (!query.trim()) {
      return MemoRepository.fullTextSearch(this.pool, {
        workspaceId,
        query: "",
        filters: repoFilters,
        limit,
      })
    }

    if (exact) {
      return MemoRepository.exactSearch(this.pool, {
        workspaceId,
        query,
        filters: repoFilters,
        limit,
      })
    }

    try {
      const embedding = await this.embeddingService.embed(query, {
        workspaceId,
        functionId: "memo-explorer-query",
      })

      const intent = classifyMemoQueryIntent(query)
      const mode = resolveMemoSearchMode(DEFAULT_MEMO_SEARCH_MODE)

      const hybridResults = await MemoRepository.hybridSearch(this.pool, {
        workspaceId,
        query,
        embedding,
        filters: repoFilters,
        limit: Math.max(limit, mode.candidatePoolSize),
        keywordWeight: intent.keywordWeight,
        semanticWeight: intent.semanticWeight,
        applyStructuralBoost: intent.intent !== "temporal",
      })

      if (hybridResults.length > 0) {
        const ranked = mode.rerank ? await this.applyRerank(workspaceId, query, hybridResults) : hybridResults
        return ranked.slice(0, limit)
      }
    } catch (error) {
      logger.warn({ error, workspaceId, query }, "Memo explorer hybrid search failed, falling back to text search")
    }

    return MemoRepository.fullTextSearch(this.pool, {
      workspaceId,
      query,
      filters: repoFilters,
      limit,
    })
  }

  /**
   * B3: reorder the top window with the fail-open reranker and append the
   * un-reranked tail unchanged (recall protection). The reranker only sees
   * rows that already passed the §3.1 access-scoped scan, so it can
   * reorder but never widen visibility; on any failure it returns identity
   * order and results are unchanged.
   */
  private async applyRerank(
    workspaceId: string,
    query: string,
    results: MemoExplorerResult[]
  ): Promise<MemoExplorerResult[]> {
    const window = Math.min(MEMO_RERANKER_CANDIDATE_LIMIT, results.length)
    if (window <= 1) return results

    const head = results.slice(0, window)
    const tail = results.slice(window)
    const order = await this.reranker.rerank(
      query,
      head.map((r) => ({ title: r.memo.title, abstract: r.memo.abstract })),
      { workspaceId }
    )
    return [...order.map((i) => head[i]), ...tail]
  }

  async getById(
    workspaceId: string,
    memoId: string,
    permissions: MemoExplorerPermissions
  ): Promise<MemoExplorerDetail | null> {
    const memo = await MemoRepository.findById(this.pool, memoId)
    if (!memo || memo.workspaceId !== workspaceId || memo.status !== "active") {
      return null
    }

    const sourceContext = await this.loadSourceContext(memo)
    if (!sourceContext.sourceStream || !permissions.accessibleStreamIds.includes(sourceContext.sourceStream.id)) {
      return null
    }

    const sourceMessages = await this.loadSourceMessages(workspaceId, memo, permissions.accessibleStreamIds)

    return {
      memo,
      distance: 0,
      sourceStream: this.toStreamRef(sourceContext.sourceStream),
      rootStream: this.toStreamRef(sourceContext.rootStream),
      sourceMessages,
    }
  }

  private resolveStreamIds(accessibleStreamIds: string[], requestedStreamIds?: string[]): string[] {
    if (!requestedStreamIds?.length) {
      return accessibleStreamIds
    }

    const accessibleSet = new Set(accessibleStreamIds)
    return [...new Set(requestedStreamIds)].filter((streamId) => accessibleSet.has(streamId))
  }

  private async loadSourceContext(memo: Memo): Promise<{ sourceStream: Stream | null; rootStream: Stream | null }> {
    let sourceStreamId: string | null = null

    if (memo.sourceMessageId) {
      const sourceMessage = await MessageRepository.findById(this.pool, memo.sourceMessageId)
      sourceStreamId = sourceMessage?.streamId ?? null
    } else if (memo.sourceConversationId) {
      const sourceConversation = await ConversationRepository.findById(this.pool, memo.sourceConversationId)
      sourceStreamId = sourceConversation?.streamId ?? null
    }

    if (!sourceStreamId && memo.sourceMessageIds.length > 0) {
      const sourceMessages = await MessageRepository.findByIds(this.pool, memo.sourceMessageIds)
      sourceStreamId = sourceMessages.get(memo.sourceMessageIds[0] ?? "")?.streamId ?? null
    }

    if (!sourceStreamId) {
      return { sourceStream: null, rootStream: null }
    }

    const sourceStream = await StreamRepository.findById(this.pool, sourceStreamId)
    if (!sourceStream) {
      return { sourceStream: null, rootStream: null }
    }

    const rootStream = sourceStream.rootStreamId
      ? await StreamRepository.findById(this.pool, sourceStream.rootStreamId)
      : null
    return { sourceStream, rootStream }
  }

  private async loadSourceMessages(
    workspaceId: string,
    memo: Memo,
    accessibleStreamIds: string[]
  ): Promise<MemoExplorerSourceMessage[]> {
    const sourceMessagesMap = await MessageRepository.findByIds(this.pool, memo.sourceMessageIds)
    if (sourceMessagesMap.size === 0) {
      return []
    }

    const sourceMessages = memo.sourceMessageIds
      .map((messageId) => sourceMessagesMap.get(messageId))
      .filter((message): message is Message => Boolean(message))
      .filter((message) => accessibleStreamIds.includes(message.streamId))

    if (sourceMessages.length === 0) {
      return []
    }

    const userIds = new Set<string>()
    const personaIds = new Set<string>()
    const streamIds = new Set<string>()

    for (const message of sourceMessages) {
      if (message.authorType === "user") {
        userIds.add(message.authorId)
      } else if (message.authorType === "persona") {
        personaIds.add(message.authorId)
      }
      streamIds.add(message.streamId)
    }

    const [members, personas, streams] = await Promise.all([
      userIds.size > 0 ? UserRepository.findByIds(this.pool, workspaceId, [...userIds]) : Promise.resolve([]),
      personaIds.size > 0 ? PersonaRepository.findByIds(this.pool, [...personaIds], workspaceId) : Promise.resolve([]),
      StreamRepository.findByIds(this.pool, [...streamIds]),
    ])

    const memberMap = new Map(members.map((member) => [member.id, member]))
    const personaMap = new Map(personas.map((persona) => [persona.id, persona]))
    const streamMap = new Map(streams.map((stream) => [stream.id, stream]))

    return sourceMessages.map((message) => ({
      id: message.id,
      streamId: message.streamId,
      streamName: this.getStreamName(streamMap.get(message.streamId)),
      authorId: message.authorId,
      authorType: message.authorType,
      authorName:
        message.authorType === "user"
          ? (memberMap.get(message.authorId)?.name ?? "Unknown")
          : (personaMap.get(message.authorId)?.name ?? "Assistant"),
      content: message.contentMarkdown,
      createdAt: message.createdAt,
    }))
  }

  private toStreamRef(stream: Stream | null): MemoStreamRef | null {
    if (!stream) {
      return null
    }

    return {
      id: stream.id,
      type: stream.type,
      name: this.getStreamName(stream),
    }
  }

  private getStreamName(stream: Stream | undefined): string {
    if (!stream) {
      return "Unknown stream"
    }
    return stream.displayName ?? stream.slug ?? stream.type
  }
}
