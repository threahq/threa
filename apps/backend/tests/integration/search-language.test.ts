/**
 * Language-aware keyword search against the real schema: `messages.language`
 * picks the stemmer for `search_vector` and a query is parsed under every
 * stemmer, so an inflected Swedish word matches its base form the way an
 * English one always has. Proven end to end through EventService and
 * SearchService because the generated column, the IMMUTABLE config function
 * and the OR-ed tsquery only exist in Postgres (INV-68).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { plan, processChunk } from "../../src/features/messaging/language-backfill"
import { SearchService, resolveUserAccessibleStreamIds, type SearchPermissions } from "../../src/features/search"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { SEARCH_CONFIG_BY_LANGUAGE, UNDETECTED_LANGUAGE } from "../../src/lib/text-language"
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

describe("Language-aware message keyword search", () => {
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
        name: "Language Search Test Workspace",
        slug: `language-search-${testWorkspaceId}`,
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

  async function storedLanguage(messageId: string): Promise<string | null> {
    const result = await pool.query<{ language: string | null }>("SELECT language FROM messages WHERE id = $1", [
      messageId,
    ])
    return result.rows[0]!.language
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

      expect(await storedLanguage(swedish.id)).toBe("sv")
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

      expect(await storedLanguage(english.id)).toBe("en")
      expect(await searchIds(ws, "invoice", ranking.searchFlag)).toEqual([english.id])
    })
  }

  test("should stem a short message as English and store it as undetected", async () => {
    const ws = await seedWorkspaceWithStream()
    const short = await postMessage({
      workspaceId: ws.workspaceId,
      streamId: ws.streamId,
      authorId: ws.userId,
      text: "invoices sent",
    })

    expect(await storedLanguage(short.id)).toBe(UNDETECTED_LANGUAGE)
    expect(await searchIds(ws, "invoice", "on")).toEqual([short.id])
  })

  test("should re-detect the language when an edit rewrites the body", async () => {
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
      ...testMessageContent("Jag har skickat fakturorna nu, säg till om något saknas"),
    })

    expect(await storedLanguage(message.id)).toBe("sv")
    expect(await searchIds(ws, "faktura", "on")).toEqual([message.id])
  })

  test("should resolve every detector code to the same config the query side ORs across", async () => {
    const entries = [...Object.entries(SEARCH_CONFIG_BY_LANGUAGE), [UNDETECTED_LANGUAGE, "english"], [null, "english"]]
    const result = await pool.query<{ lang: string | null; config: string }>(
      `SELECT v.lang, search_config_for_language(v.lang)::text AS config
       FROM UNNEST($1::text[]) WITH ORDINALITY AS v(lang, ord)
       ORDER BY v.ord`,
      [entries.map(([lang]) => lang)]
    )
    expect(result.rows.map((row) => row.config)).toEqual(entries.map(([, config]) => config))
  })

  describe("message-language backfill", () => {
    test("should fill language on rows written before the column and leave detected rows alone", async () => {
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
      await pool.query("UPDATE messages SET language = NULL WHERE id = ANY($1)", [[legacyRow.id, otherWorkspaceRow.id]])
      expect(await searchIds(ws, "faktura", "on")).toEqual([])

      const ctx = { pool }
      const chunks = await plan(ctx, ws.workspaceId)
      expect(chunks).toEqual([{ ids: [legacyRow.id] }])

      const processed = await Promise.all(chunks.map((chunk) => processChunk(ctx, ws.workspaceId, chunk)))
      expect(processed).toEqual([{ processed: 1 }])
      expect(await storedLanguage(legacyRow.id)).toBe("sv")
      expect(await storedLanguage(otherWorkspaceRow.id)).toBeNull()
      expect(await searchIds(ws, "faktura", "on")).toEqual([legacyRow.id])

      // Idempotent: a redelivered chunk finds nothing left to fill.
      expect(await processChunk(ctx, ws.workspaceId, chunks[0]!)).toEqual({ processed: 0 })
    })
  })
})
