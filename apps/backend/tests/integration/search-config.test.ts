/**
 * `messages.search_config` picks the stemmer for `search_vector` and a query
 * is parsed under every stemmer, so an inflected non-English word matches its
 * base form the way an English one always has. Proven end to end through
 * EventService and SearchService because the generated column, the IMMUTABLE
 * config function and the OR-ed tsquery only exist in Postgres (INV-68).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { plan, processChunk } from "../../src/features/messaging/search-config-backfill"
import { SearchService, resolveUserAccessibleStreamIds, type SearchPermissions } from "../../src/features/search"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { DEFAULT_SEARCH_CONFIG, SEARCH_TEXT_CONFIGS } from "../../src/lib/text-search-config"
import { userId, workspaceId, streamId } from "../../src/lib/id"

const EMBEDDING_DIMS = 1536
const ZERO_VECTOR = new Array(EMBEDDING_DIMS).fill(0)

const RANKINGS = [
  { name: "legacy", searchFlag: "off" },
  { name: "improved", searchFlag: "on" },
] as const

function fakeEmbeddingService(): EmbeddingServiceLike {
  return { embed: async () => ZERO_VECTOR, embedBatch: async () => [] }
}

describe("Per-message text-search config", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  function makeService() {
    return new SearchService({
      pool,
      embeddingService: fakeEmbeddingService(),
      queryExpander: { expand: async () => [] },
      reranker: { rerank: async (_q, candidates) => candidates.map((_, i) => i) },
    })
  }

  async function seedWorkspaceWithStream() {
    const testWorkspaceId = workspaceId()
    let testUserId = userId()
    const testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Search Config Test Workspace",
        slug: `search-config-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
      await StreamMemberRepository.insert(client, testStreamId, testUserId)
    })

    const accessibleStreamIds = await resolveUserAccessibleStreamIds(pool, testWorkspaceId, testUserId, {})
    const permissions: SearchPermissions = { accessibleStreamIds }
    return { workspaceId: testWorkspaceId, userId: testUserId, streamId: testStreamId, permissions }
  }

  function postMessage(params: { workspaceId: string; streamId: string; authorId: string; text: string }) {
    return new EventService(pool).createMessage({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      authorId: params.authorId,
      authorType: "user",
      ...testMessageContent(params.text),
    })
  }

  async function storedConfig(messageId: string): Promise<string | null> {
    const result = await pool.query<{ search_config: string | null }>(
      "SELECT search_config FROM messages WHERE id = $1",
      [messageId]
    )
    return result.rows[0]!.search_config
  }

  async function searchIds(
    params: { workspaceId: string; permissions: SearchPermissions },
    query: string,
    searchFlag: "on" | "off"
  ) {
    const { results } = await makeService().search({
      searchFlag,
      workspaceId: params.workspaceId,
      permissions: params.permissions,
      query,
    })
    return results.map((r) => r.id)
  }

  for (const ranking of RANKINGS) {
    test(`should match an inflected Swedish word from its base form under ${ranking.name} ranking`, async () => {
      const ws = await seedWorkspaceWithStream()
      const swedish = await postMessage({
        workspaceId: ws.workspaceId,
        streamId: ws.streamId,
        authorId: ws.userId,
        text: "Jag har skickat fakturorna nu, säg till om något saknas",
      })
      await postMessage({
        workspaceId: ws.workspaceId,
        streamId: ws.streamId,
        authorId: ws.userId,
        text: "The invoices went out this morning, shout if anything is missing",
      })

      expect(await storedConfig(swedish.id)).toBe("swedish")
      expect(await searchIds(ws, "faktura", ranking.searchFlag)).toEqual([swedish.id])
    })

    test(`should keep matching inflected English under ${ranking.name} ranking`, async () => {
      const ws = await seedWorkspaceWithStream()
      const english = await postMessage({
        workspaceId: ws.workspaceId,
        streamId: ws.streamId,
        authorId: ws.userId,
        text: "The invoices went out this morning, shout if anything is missing",
      })
      await postMessage({
        workspaceId: ws.workspaceId,
        streamId: ws.streamId,
        authorId: ws.userId,
        text: "Jag har skickat fakturorna nu, säg till om något saknas",
      })

      expect(await storedConfig(english.id)).toBe("english")
      expect(await searchIds(ws, "invoice", ranking.searchFlag)).toEqual([english.id])
    })
  }

  test("should stem a short message as English", async () => {
    const ws = await seedWorkspaceWithStream()
    const short = await postMessage({
      workspaceId: ws.workspaceId,
      streamId: ws.streamId,
      authorId: ws.userId,
      text: "invoices sent",
    })

    expect(await storedConfig(short.id)).toBe(DEFAULT_SEARCH_CONFIG)
    expect(await searchIds(ws, "invoice", "on")).toEqual([short.id])
  })

  test("should re-detect the config when an edit rewrites the body", async () => {
    const ws = await seedWorkspaceWithStream()
    const eventService = new EventService(pool)
    const message = await postMessage({
      workspaceId: ws.workspaceId,
      streamId: ws.streamId,
      authorId: ws.userId,
      text: "The invoices went out this morning, shout if anything is missing",
    })
    await eventService.editMessageInternal({
      workspaceId: ws.workspaceId,
      messageId: message.id,
      streamId: ws.streamId,
      actorId: ws.userId,
      ...testMessageContent("Die Rechnungen sind heute Morgen rausgegangen, sag Bescheid wenn etwas fehlt"),
    })

    expect(await storedConfig(message.id)).toBe("german")
    expect(await searchIds(ws, "Rechnung", "on")).toEqual([message.id])
  })

  test("should resolve every configured name, and NULL, to a Postgres config", async () => {
    const names = [...SEARCH_TEXT_CONFIGS, null]
    const result = await pool.query<{ config: string }>(
      `SELECT text_search_config(v.name)::text AS config
       FROM UNNEST($1::text[]) WITH ORDINALITY AS v(name, ord)
       ORDER BY v.ord`,
      [names]
    )
    expect(result.rows.map((row) => row.config)).toEqual([...SEARCH_TEXT_CONFIGS, DEFAULT_SEARCH_CONFIG])
  })

  describe("message-search-config backfill", () => {
    test("should fill search_config on rows written before the column and leave detected rows alone", async () => {
      const ws = await seedWorkspaceWithStream()
      const other = await seedWorkspaceWithStream()
      const legacyRow = await postMessage({
        workspaceId: ws.workspaceId,
        streamId: ws.streamId,
        authorId: ws.userId,
        text: "Jag har skickat fakturorna nu, säg till om något saknas",
      })
      const otherWorkspaceRow = await postMessage({
        workspaceId: other.workspaceId,
        streamId: other.streamId,
        authorId: other.userId,
        text: "Jag har skickat fakturorna nu, säg till om något saknas",
      })
      await pool.query("UPDATE messages SET search_config = NULL WHERE id = ANY($1)", [
        [legacyRow.id, otherWorkspaceRow.id],
      ])
      expect(await searchIds(ws, "faktura", "on")).toEqual([])

      const ctx = { pool }
      const chunks = await plan(ctx, ws.workspaceId)
      expect(chunks).toEqual([{ ids: [legacyRow.id] }])

      const processed = await Promise.all(chunks.map((chunk) => processChunk(ctx, ws.workspaceId, chunk)))
      expect(processed).toEqual([{ processed: 1 }])
      expect(await storedConfig(legacyRow.id)).toBe("swedish")
      expect(await storedConfig(otherWorkspaceRow.id)).toBeNull()
      expect(await searchIds(ws, "faktura", "on")).toEqual([legacyRow.id])

      // Idempotent: a redelivered chunk finds nothing left to fill.
      expect(await processChunk(ctx, ws.workspaceId, chunks[0]!)).toEqual({ processed: 0 })
    })
  })
})
