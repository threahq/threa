/**
 * `memos.search_config` and `attachment_extractions.search_config` pick the
 * stemmer for their full-text search the way `messages.search_config` already
 * does, so an inflected non-English word matches its base form. The two read
 * paths differ: memo search builds its tsvector per row (no stored column, no
 * index), so both sides use that row's own config; an extraction's
 * `search_vector` is stored and GIN-indexed, so the query is parsed under every
 * config and OR-ed instead. Both shapes only exist in Postgres (INV-68).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { MemoExplorerService, MemoRepository, type EmbeddingServiceLike } from "../../src/features/memos"
import {
  plan as planMemoConfigs,
  processChunk as processMemoConfigs,
} from "../../src/features/memos/search-config-backfill"
import { AttachmentRepository, AttachmentExtractionRepository } from "../../src/features/attachments"
import {
  plan as planExtractionConfigs,
  processChunk as processExtractionConfigs,
} from "../../src/features/attachments/search-config-backfill"
import { userId, workspaceId, streamId, messageId, memoId, attachmentId, extractionId } from "../../src/lib/id"
import { AttachmentSafetyStatuses } from "@threahq/types"

function fakeEmbeddingService(): EmbeddingServiceLike {
  return { embed: async () => new Array(1536).fill(0), embedBatch: async () => [] }
}

const SWEDISH_ABSTRACT = "Jag har skickat fakturorna nu, säg till om något saknas"
const ENGLISH_ABSTRACT = "The invoices were sent this morning, tell me if anything is missing"

describe("Per-row text-search config for memos and attachments", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedWorkspaceWithStream() {
    const testWorkspaceId = workspaceId()
    let testUserId = userId()
    const testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo/Attachment Search Config",
        slug: `memo-attachment-config-${testWorkspaceId}`,
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

    return { workspaceId: testWorkspaceId, userId: testUserId, streamId: testStreamId }
  }

  describe("memos", () => {
    function makeExplorer() {
      return new MemoExplorerService({
        pool,
        embeddingService: fakeEmbeddingService(),
        reranker: undefined,
      })
    }

    async function insertMemo(ws: { workspaceId: string; streamId: string; userId: string }, abstract: string) {
      const id = memoId()
      const sourceMessageId = messageId()
      await withTransaction(pool, async (client) => {
        await MessageRepository.insert(client, {
          id: sourceMessageId,
          streamId: ws.streamId,
          sequence: BigInt(Date.now()),
          authorId: ws.userId,
          authorType: "user",
          ...testMessageContent("source"),
        })
        await MemoRepository.insert(client, {
          id,
          workspaceId: ws.workspaceId,
          memoType: "message",
          sourceMessageId,
          title: "Fakturor",
          abstract,
          keyPoints: [],
          sourceMessageIds: [sourceMessageId],
          participantIds: [ws.userId],
          knowledgeType: "decision",
          tags: [],
          status: "active",
        })
      })
      return id
    }

    async function storedConfig(id: string): Promise<string | null> {
      const result = await pool.query<{ search_config: string | null }>(
        "SELECT search_config FROM memos WHERE id = $1",
        [id]
      )
      return result.rows[0]!.search_config
    }

    /** Resolves once the edit above is parked on the memo's row lock. */
    async function waitForRowLockWaiter(): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt++) {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' LIMIT 1"
        )
        if (waiting.rowCount) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error("the memo edit never blocked on the row lock")
    }

    async function searchIds(testWorkspaceId: string, query: string): Promise<string[]> {
      const results = await MemoRepository.fullTextSearch(pool, { workspaceId: testWorkspaceId, query, limit: 20 })
      return results.map((r) => r.memo.id)
    }

    test("should match an inflected Swedish word from its base form", async () => {
      const ws = await seedWorkspaceWithStream()
      const swedish = await insertMemo(ws, SWEDISH_ABSTRACT)

      expect(await storedConfig(swedish)).toBe("swedish")
      expect(await searchIds(ws.workspaceId, "faktura")).toEqual([swedish])
    })

    test("should keep stemming an English memo as English", async () => {
      const ws = await seedWorkspaceWithStream()
      const english = await insertMemo(ws, ENGLISH_ABSTRACT)

      expect(await storedConfig(english)).toBe("english")
      expect(await searchIds(ws.workspaceId, "invoice")).toEqual([english])
    })

    test("should re-detect the config from the whole memo when an edit changes its text", async () => {
      const ws = await seedWorkspaceWithStream()
      const memo = await insertMemo(ws, ENGLISH_ABSTRACT)
      expect(await storedConfig(memo)).toBe("english")

      await makeExplorer().update(
        ws.workspaceId,
        memo,
        { accessibleStreamIds: [ws.streamId], userId: ws.userId },
        { abstract: SWEDISH_ABSTRACT }
      )

      expect(await storedConfig(memo)).toBe("swedish")
      expect(await searchIds(ws.workspaceId, "faktura")).toEqual([memo])
    })

    test("should detect the stemmer from a concurrent edit's text rather than a stale read", async () => {
      const ws = await seedWorkspaceWithStream()
      const memo = await insertMemo(ws, ENGLISH_ABSTRACT)
      expect(await storedConfig(memo)).toBe("english")

      const blocker = await pool.connect()
      try {
        await blocker.query("BEGIN")
        await blocker.query("SELECT id FROM memos WHERE id = $1 FOR UPDATE", [memo])

        // A key-points-only edit carries no abstract, so its stemmer comes from
        // the rest of the memo — which the blocked write below replaces.
        const edit = makeExplorer().update(
          ws.workspaceId,
          memo,
          { accessibleStreamIds: [ws.streamId], userId: ws.userId },
          { keyPoints: ["Noted"] }
        )
        await waitForRowLockWaiter()

        await blocker.query("UPDATE memos SET abstract = $2 WHERE id = $1", [memo, SWEDISH_ABSTRACT])
        await blocker.query("COMMIT")
        await edit
      } finally {
        blocker.release()
      }

      expect(await storedConfig(memo)).toBe("swedish")
      expect(await searchIds(ws.workspaceId, "faktura")).toEqual([memo])
    })

    test("should fill search_config on memos written before the column and leave detected rows alone", async () => {
      const ws = await seedWorkspaceWithStream()
      const other = await seedWorkspaceWithStream()
      const legacyRow = await insertMemo(ws, SWEDISH_ABSTRACT)
      const otherWorkspaceRow = await insertMemo(other, SWEDISH_ABSTRACT)
      const detectedRow = await insertMemo(ws, SWEDISH_ABSTRACT)
      await pool.query("UPDATE memos SET search_config = NULL WHERE id = ANY($1)", [[legacyRow, otherWorkspaceRow]])
      expect(await searchIds(ws.workspaceId, "faktura")).toEqual([detectedRow])

      const ctx = { pool }
      const chunks = await planMemoConfigs(ctx, ws.workspaceId)
      expect(chunks).toEqual([{ ids: [legacyRow] }])

      const processed = await Promise.all(chunks.map((chunk) => processMemoConfigs(ctx, ws.workspaceId, chunk)))
      expect(processed).toEqual([{ processed: 1 }])
      expect(await storedConfig(legacyRow)).toBe("swedish")
      expect(await storedConfig(otherWorkspaceRow)).toBeNull()
      expect((await searchIds(ws.workspaceId, "faktura")).sort()).toEqual([detectedRow, legacyRow].sort())

      // Idempotent: a redelivered chunk finds nothing left to fill.
      expect(await processMemoConfigs(ctx, ws.workspaceId, chunks[0]!)).toEqual({ processed: 0 })
    })
  })

  describe("attachment extractions", () => {
    async function insertAttachmentWithExtraction(
      ws: { workspaceId: string; streamId: string; userId: string },
      summary: string
    ): Promise<{ attachmentId: string; extractionId: string }> {
      const attId = attachmentId()
      const extId = extractionId()
      await withTransaction(pool, async (client) => {
        const { message } = await new EventService(pool).createMessageInTransaction(client, {
          workspaceId: ws.workspaceId,
          streamId: ws.streamId,
          authorId: ws.userId,
          authorType: "user",
          ...testMessageContent("attachment carrier"),
        })
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: ws.workspaceId,
          streamId: ws.streamId,
          uploadedBy: ws.userId,
          filename: `${attId}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: `/test/${attId}`,
          safetyStatus: AttachmentSafetyStatuses.CLEAN,
        })
        await client.query("UPDATE attachments SET message_id = $1 WHERE id = $2", [message.id, attId])
        await AttachmentExtractionRepository.insert(client, {
          id: extId,
          attachmentId: attId,
          workspaceId: ws.workspaceId,
          contentType: "document",
          summary,
          fullText: null,
        })
      })
      return { attachmentId: attId, extractionId: extId }
    }

    async function storedConfig(id: string): Promise<string | null> {
      const result = await pool.query<{ search_config: string | null }>(
        "SELECT search_config FROM attachment_extractions WHERE id = $1",
        [id]
      )
      return result.rows[0]!.search_config
    }

    async function searchIds(ws: { workspaceId: string; userId: string }, queryText: string): Promise<string[]> {
      const rows = await AttachmentRepository.search(pool, {
        workspaceId: ws.workspaceId,
        userId: ws.userId,
        queryText,
        limit: 20,
      })
      return rows.map((r) => r.id)
    }

    test("should match an inflected Swedish word in an extract from its base form", async () => {
      const ws = await seedWorkspaceWithStream()
      const swedish = await insertAttachmentWithExtraction(ws, SWEDISH_ABSTRACT)

      expect(await storedConfig(swedish.extractionId)).toBe("swedish")
      expect(await searchIds(ws, "faktura")).toEqual([swedish.attachmentId])
    })

    test("should keep stemming an English extract as English", async () => {
      const ws = await seedWorkspaceWithStream()
      const english = await insertAttachmentWithExtraction(ws, ENGLISH_ABSTRACT)

      expect(await storedConfig(english.extractionId)).toBe("english")
      expect(await searchIds(ws, "invoice")).toEqual([english.attachmentId])
    })

    test("should carry the config to a copied extraction, whose text is identical", async () => {
      const ws = await seedWorkspaceWithStream()
      const source = await insertAttachmentWithExtraction(ws, SWEDISH_ABSTRACT)
      const copyAttachmentId = attachmentId()
      const copyExtractionId = extractionId()

      const copied = await withTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: copyAttachmentId,
          workspaceId: ws.workspaceId,
          streamId: ws.streamId,
          uploadedBy: ws.userId,
          filename: `${copyAttachmentId}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: `/test/${copyAttachmentId}`,
          safetyStatus: AttachmentSafetyStatuses.CLEAN,
        })
        return AttachmentExtractionRepository.copyForAttachment(client, {
          id: copyExtractionId,
          sourceAttachmentId: source.attachmentId,
          attachmentId: copyAttachmentId,
          workspaceId: ws.workspaceId,
        })
      })

      expect(copied).toBe(true)
      expect(await storedConfig(copyExtractionId)).toBe("swedish")
    })

    test("should fill search_config on extractions written before the column and leave detected rows alone", async () => {
      const ws = await seedWorkspaceWithStream()
      const other = await seedWorkspaceWithStream()
      const legacyRow = await insertAttachmentWithExtraction(ws, SWEDISH_ABSTRACT)
      const otherWorkspaceRow = await insertAttachmentWithExtraction(other, SWEDISH_ABSTRACT)
      const detectedRow = await insertAttachmentWithExtraction(ws, SWEDISH_ABSTRACT)
      await pool.query("UPDATE attachment_extractions SET search_config = NULL WHERE id = ANY($1)", [
        [legacyRow.extractionId, otherWorkspaceRow.extractionId],
      ])
      expect(await searchIds(ws, "faktura")).toEqual([detectedRow.attachmentId])

      const ctx = { pool }
      const chunks = await planExtractionConfigs(ctx, ws.workspaceId)
      expect(chunks).toEqual([{ ids: [legacyRow.extractionId] }])

      const processed = await Promise.all(chunks.map((chunk) => processExtractionConfigs(ctx, ws.workspaceId, chunk)))
      expect(processed).toEqual([{ processed: 1 }])
      expect(await storedConfig(legacyRow.extractionId)).toBe("swedish")
      expect(await storedConfig(otherWorkspaceRow.extractionId)).toBeNull()
      expect((await searchIds(ws, "faktura")).sort()).toEqual([detectedRow.attachmentId, legacyRow.attachmentId].sort())

      // Idempotent: a redelivered chunk finds nothing left to fill.
      expect(await processExtractionConfigs(ctx, ws.workspaceId, chunks[0]!)).toEqual({ processed: 0 })
    })
  })
})
