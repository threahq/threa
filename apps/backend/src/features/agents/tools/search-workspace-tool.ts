import { z } from "zod"
import { AgentStepTypes, STREAM_TYPES, StreamTypes } from "@threa/types"
import { logger } from "../../../lib/logger"
import { searchDmStreamsByParticipant, StreamRepository } from "../../streams"
import { UserRepository } from "../../workspaces"
import { MessageRepository } from "../../messaging"
import { PersonaRepository } from "../persona-repository"
import { enrichMessageSearchResults } from "../researcher"
import { resolveStreamIdentifier } from "./identifier-resolver"
import { defineAgentTool, type AgentToolResult } from "../runtime"
import type { WorkspaceToolDeps } from "./tool-deps"

// Schema for search_messages tool
const SearchMessagesSchema = z.object({
  query: z.string().describe("The search query to find relevant messages in the workspace"),
  stream: z
    .string()
    .optional()
    .describe(
      "Optional: limit search to a specific stream. Can be an ID (stream_xxx), a slug (general), or a prefixed slug (#general)"
    ),
  exact: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, search for exact phrase matches instead of semantic similarity"),
})

export type SearchMessagesInput = z.infer<typeof SearchMessagesSchema>

export interface MessageSearchResult {
  id: string
  content: string
  authorName: string
  streamName: string
  createdAt: string
}

// Schema for search_streams tool
const SearchStreamsSchema = z.object({
  query: z.string().describe("The search query to find streams by name or description"),
  types: z.array(z.enum(STREAM_TYPES)).optional().describe("Filter by stream types"),
})

export type SearchStreamsInput = z.infer<typeof SearchStreamsSchema>

export interface StreamSearchResult {
  id: string
  type: string
  name: string | null
  description: string | null
}

interface RankedStreamSearchResult {
  result: StreamSearchResult
  score: number
  sourceOrder: number
}

// Schema for search_users tool
const SearchUsersSchema = z.object({
  query: z.string().describe("The search query to find users by slug, name, or email"),
})

export type SearchUsersInput = z.infer<typeof SearchUsersSchema>

export interface UserSearchResult {
  id: string
  name: string
  email: string
}

// Schema for get_stream_messages tool
const GetStreamMessagesSchema = z.object({
  stream: z
    .string()
    .describe(
      "The stream to get messages from. Can be an ID (stream_xxx), a slug (general), or a prefixed slug (#general)"
    ),
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("Maximum number of recent messages to retrieve (default: 10, max: 20)"),
})

export type GetStreamMessagesInput = z.infer<typeof GetStreamMessagesSchema>

export interface StreamMessagesResult {
  id: string
  content: string
  authorName: string
  authorType: string
  createdAt: string
}

const MAX_RESULTS = 10
const MAX_STREAM_MESSAGES = 20

export function createSearchMessagesTool(deps: WorkspaceToolDeps) {
  const { db, workspaceId, accessibleStreamIds, invokingUserId, searchService } = deps

  return defineAgentTool({
    name: "search_messages",
    description: `Search for messages in the workspace knowledge base. Use this to find:
- Previous discussions about a topic
- Specific information mentioned in past conversations
- Context about decisions or plans

Set exact=true to find literal phrase matches (useful for error messages, IDs, or quoted text).
Optionally filter by stream using ID (stream_xxx), slug (general), or prefixed slug (#general).`,
    inputSchema: SearchMessagesSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        let filterStreamIds = accessibleStreamIds
        if (input.stream) {
          const resolved = await resolveStreamIdentifier(db, workspaceId, input.stream, accessibleStreamIds)
          if (!resolved.resolved)
            return {
              output: JSON.stringify({
                query: input.query,
                stream: input.stream,
                exact: input.exact,
                results: [],
                message: "No matching messages found",
              }),
            }
          filterStreamIds = [resolved.id]
        }

        const { results: searchResults } = await searchService.search({
          workspaceId,
          permissions: { accessibleStreamIds },
          query: input.query,
          filters: input.stream ? { streamIds: filterStreamIds } : undefined,
          limit: 10,
          exact: input.exact,
        })

        const enriched = await enrichMessageSearchResults(db, workspaceId, searchResults)
        const results: MessageSearchResult[] = enriched.map((r) => ({
          id: r.id,
          content: r.content,
          authorName: r.authorName,
          streamName: r.streamName,
          createdAt: r.createdAt.toISOString(),
        }))

        if (results.length === 0) {
          return {
            output: JSON.stringify({
              query: input.query,
              stream: input.stream,
              exact: input.exact,
              results: [],
              message: "No matching messages found",
            }),
          }
        }

        logger.debug(
          { query: input.query, stream: input.stream, exact: input.exact, resultCount: results.length },
          "Message search completed"
        )

        return {
          output: JSON.stringify({
            query: input.query,
            stream: input.stream,
            exact: input.exact,
            results: results.slice(0, MAX_RESULTS).map((r) => ({
              id: r.id,
              content: truncate(r.content, 300),
              author: r.authorName,
              stream: r.streamName,
              date: r.createdAt,
            })),
          }),
        }
      } catch (error) {
        logger.error({ error, query: input.query }, "Message search failed")
        return {
          output: JSON.stringify({
            error: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            query: input.query,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      hidden: true,
      formatContent: (input) =>
        JSON.stringify({
          tool: "search_messages",
          query: input.query ?? "",
          stream: input.stream ?? null,
        }),
    },
  })
}

export function createSearchStreamsTool(deps: WorkspaceToolDeps) {
  const { db, workspaceId, accessibleStreamIds, invokingUserId } = deps

  return defineAgentTool({
    name: "search_streams",
    description: `Search for streams (channels, scratchpads, DMs) in the workspace. Use this to find:
- Specific channels or conversations
- Where certain topics are discussed
- Related discussions in other streams`,
    inputSchema: SearchStreamsSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const normalizedQuery = input.query.trim()
        if (normalizedQuery.length === 0) {
          return {
            output: JSON.stringify({
              query: input.query,
              types: input.types,
              results: [],
              message: "Search query cannot be empty",
            }),
          }
        }

        const [nameMatches, dmSearchResults] = await Promise.all([
          StreamRepository.searchByName(db, {
            streamIds: accessibleStreamIds,
            query: normalizedQuery,
            types: input.types,
            limit: MAX_RESULTS,
          }),
          searchDmStreamsByParticipant({
            db,
            workspaceId,
            invokingUserId,
            accessibleStreamIds,
            query: normalizedQuery,
            types: input.types,
            limit: MAX_RESULTS,
          }),
        ])

        const dmDisplayNamesById = new Map(dmSearchResults.map((result) => [result.streamId, result.displayName]))
        const rankedResults: RankedStreamSearchResult[] = [
          ...nameMatches.map((stream, index): RankedStreamSearchResult => {
            // Use viewer-resolved DM name when available so ranking aligns with what users see.
            // For non-DM streams, score against displayName/slug as before.
            // If no resolved DM label exists, fall back to persisted stream naming fields.
            const searchText =
              stream.type === StreamTypes.DM
                ? (dmDisplayNamesById.get(stream.id) ?? stream.displayName ?? stream.slug ?? "")
                : (stream.displayName ?? stream.slug ?? "")

            return {
              result: {
                id: stream.id,
                type: stream.type,
                name:
                  stream.type === StreamTypes.DM
                    ? (dmDisplayNamesById.get(stream.id) ?? stream.displayName ?? "(direct message)")
                    : (stream.displayName ?? stream.slug ?? null),
                description: stream.description ?? null,
              },
              score: scoreStreamSearchResultName(searchText, normalizedQuery),
              sourceOrder: index,
            }
          }),
          ...dmSearchResults.map(
            (result, index): RankedStreamSearchResult => ({
              result: {
                id: result.streamId,
                type: StreamTypes.DM,
                name: result.displayName,
                description: null,
              },
              score: result.score,
              sourceOrder: nameMatches.length + index,
            })
          ),
        ]

        const bestResultById = new Map<string, RankedStreamSearchResult>()
        for (const entry of rankedResults) {
          const existing = bestResultById.get(entry.result.id)
          if (
            !existing ||
            entry.score < existing.score ||
            (entry.score === existing.score && entry.sourceOrder < existing.sourceOrder)
          ) {
            bestResultById.set(entry.result.id, entry)
          }
        }

        const results = [...bestResultById.values()]
          .sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score
            if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder
            return (a.result.name ?? "").localeCompare(b.result.name ?? "")
          })
          .map((entry) => entry.result)
          .slice(0, MAX_RESULTS)

        if (results.length === 0) {
          return {
            output: JSON.stringify({
              query: input.query,
              types: input.types,
              results: [],
              message: "No matching streams found",
            }),
          }
        }

        logger.debug({ query: input.query, types: input.types, resultCount: results.length }, "Stream search completed")

        return {
          output: JSON.stringify({
            query: input.query,
            types: input.types,
            results: results.slice(0, MAX_RESULTS).map((r) => ({
              id: r.id,
              type: r.type,
              name: r.name ?? "(unnamed)",
              description: r.description ? truncate(r.description, 100) : null,
            })),
          }),
        }
      } catch (error) {
        logger.error({ error, query: input.query }, "Stream search failed")
        return {
          output: JSON.stringify({
            error: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            query: input.query,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      hidden: true,
      formatContent: (input) => JSON.stringify({ tool: "search_streams", query: input.query ?? "" }),
    },
  })
}

export function createSearchUsersTool(deps: WorkspaceToolDeps) {
  const { db, workspaceId } = deps

  return defineAgentTool({
    name: "search_users",
    description: `Search for users in the workspace by name or email. Use this to find:
- A specific person
- Who to ask about a topic
- Contact information`,
    inputSchema: SearchUsersSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const members = await UserRepository.searchByNameOrSlug(db, workspaceId, input.query, 10)
        const results: UserSearchResult[] = members.map((m) => ({ id: m.id, name: m.name, email: m.email }))

        if (results.length === 0) {
          return {
            output: JSON.stringify({
              query: input.query,
              results: [],
              message: "No matching users found",
            }),
          }
        }

        logger.debug({ query: input.query, resultCount: results.length }, "User search completed")

        return {
          output: JSON.stringify({
            query: input.query,
            results: results.slice(0, MAX_RESULTS).map((r) => ({
              id: r.id,
              name: r.name,
              email: r.email,
            })),
          }),
        }
      } catch (error) {
        logger.error({ error, query: input.query }, "User search failed")
        return {
          output: JSON.stringify({
            error: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            query: input.query,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      hidden: true,
      formatContent: (input) => JSON.stringify({ tool: "search_users", query: input.query ?? "" }),
    },
  })
}

export function createGetStreamMessagesTool(deps: WorkspaceToolDeps) {
  const { db, workspaceId, accessibleStreamIds } = deps

  return defineAgentTool({
    name: "get_stream_messages",
    description: `Get recent messages from a specific stream (channel, scratchpad, DM, or thread). Use this to:
- See what's being discussed in another stream
- Get context from a related conversation
- Check recent activity in a channel

You can reference streams by their ID (stream_xxx), slug (general), or prefixed slug (#general).`,
    inputSchema: GetStreamMessagesSchema,

    execute: async (input): Promise<AgentToolResult> => {
      try {
        const limit = Math.min(input.limit ?? 10, MAX_STREAM_MESSAGES)

        const resolved = await resolveStreamIdentifier(db, workspaceId, input.stream, accessibleStreamIds)
        if (!resolved.resolved) {
          return {
            output: JSON.stringify({
              stream: input.stream,
              messages: [],
              message: "No messages found in this stream (it may be empty or you may not have access)",
            }),
          }
        }

        const messages = await MessageRepository.list(db, resolved.id, { limit })
        messages.reverse()

        const userIds = [...new Set(messages.filter((m) => m.authorType === "user").map((m) => m.authorId))]
        const personaIds = [...new Set(messages.filter((m) => m.authorType === "persona").map((m) => m.authorId))]
        const [members, personas] = await Promise.all([
          userIds.length > 0 ? UserRepository.findByIds(db, workspaceId, userIds) : Promise.resolve([]),
          personaIds.length > 0 ? PersonaRepository.findByIds(db, personaIds, workspaceId) : Promise.resolve([]),
        ])

        const memberMap = new Map(members.map((m) => [m.id, m.name]))
        const personaMap = new Map(personas.map((p) => [p.id, p.name]))

        const results: StreamMessagesResult[] = messages.map((m) => ({
          id: m.id,
          content: m.contentMarkdown,
          authorName:
            m.authorType === "user"
              ? (memberMap.get(m.authorId) ?? "Unknown Member")
              : (personaMap.get(m.authorId) ?? "Unknown Persona"),
          authorType: m.authorType,
          createdAt: m.createdAt.toISOString(),
        }))

        if (results.length === 0) {
          return {
            output: JSON.stringify({
              stream: input.stream,
              messages: [],
              message: "No messages found in this stream (it may be empty or you may not have access)",
            }),
          }
        }

        logger.debug({ stream: input.stream, messageCount: results.length }, "Stream messages retrieved")

        return {
          output: JSON.stringify({
            stream: input.stream,
            messages: results.map((r) => ({
              id: r.id,
              content: truncate(r.content, 500),
              author: r.authorName,
              authorType: r.authorType,
              date: r.createdAt,
            })),
          }),
        }
      } catch (error) {
        logger.error({ error, stream: input.stream }, "Get stream messages failed")
        return {
          output: JSON.stringify({
            error: `Failed to get messages: ${error instanceof Error ? error.message : "Unknown error"}`,
            stream: input.stream,
          }),
        }
      }
    },

    trace: {
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      hidden: true,
      formatContent: (input) => JSON.stringify({ tool: "get_stream_messages", stream: input.stream ?? null }),
    },
  })
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + "..."
}

function scoreStreamSearchResultName(name: string, query: string): number {
  const normalizedName = name.trim().toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return Number.POSITIVE_INFINITY
  if (normalizedName === normalizedQuery) return 0
  if (normalizedName.startsWith(normalizedQuery)) return 1
  if (normalizedName.includes(normalizedQuery)) return 2
  return 3
}
