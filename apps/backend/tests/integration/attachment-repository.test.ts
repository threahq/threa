/**
 * Attachment Repository Integration Tests
 *
 * Tests verify:
 * 1. searchWithExtractions: search by filename, summary, full_text with optional content type filter
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTestTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { AttachmentRepository, AttachmentExtractionRepository } from "../../src/features/attachments"
import { userId, workspaceId, streamId, attachmentId, extractionId } from "../../src/lib/id"
import type { ExtractionContentType } from "@threahq/types"

describe("AttachmentRepository", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()

    await withTestTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Attachment Test Workspace",
        slug: `attachment-test-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      await addTestMember(client, testWorkspaceId, testUserId)
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("searchWithExtractions", () => {
    test("returns empty array when streamIds is empty", async () => {
      const result = await withTestTransaction(pool, async (client) => {
        return AttachmentRepository.searchWithExtractions(client, {
          workspaceId: testWorkspaceId,
          streamIds: [],
          query: "anything",
        })
      })

      expect(result).toEqual([])
    })

    test("finds attachment by filename match", async () => {
      const localStreamId = streamId()
      const attId = attachmentId()

      await withTestTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })

        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: localStreamId,
          uploadedBy: testUserId,
          filename: "quarterly-report-2026.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/path",
        })

        const results = await AttachmentRepository.searchWithExtractions(client, {
          workspaceId: testWorkspaceId,
          streamIds: [localStreamId],
          query: "quarterly",
        })

        expect(results.length).toBe(1)
        expect(results[0].id).toBe(attId)
        expect(results[0].filename).toBe("quarterly-report-2026.pdf")
        expect(results[0].extraction).toBeNull()
      })
    })

    test("finds attachment by extraction summary match", async () => {
      const localStreamId = streamId()
      const attId = attachmentId()
      const extId = extractionId()

      await withTestTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })

        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: localStreamId,
          uploadedBy: testUserId,
          filename: "image123.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          storagePath: "/test/image",
        })

        await AttachmentExtractionRepository.insert(client, {
          id: extId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          contentType: "screenshot",
          summary: "Screenshot showing the architecture diagram for microservices",
          fullText: null,
        })

        const results = await AttachmentRepository.searchWithExtractions(client, {
          workspaceId: testWorkspaceId,
          streamIds: [localStreamId],
          query: "architecture",
        })

        expect(results.length).toBe(1)
        expect(results[0].id).toBe(attId)
        expect(results[0].extraction).not.toBeNull()
        expect(results[0].extraction?.summary).toContain("architecture")
      })
    })

    test("finds attachment by extraction full_text match", async () => {
      const localStreamId = streamId()
      const attId = attachmentId()
      const extId = extractionId()

      await withTestTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })

        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: localStreamId,
          uploadedBy: testUserId,
          filename: "document.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4096,
          storagePath: "/test/doc",
        })

        await AttachmentExtractionRepository.insert(client, {
          id: extId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          contentType: "document",
          summary: "A business proposal document",
          fullText: "This proposal outlines the implementation strategy for the kubernetes cluster migration project.",
        })

        const results = await AttachmentRepository.searchWithExtractions(client, {
          workspaceId: testWorkspaceId,
          streamIds: [localStreamId],
          query: "kubernetes",
        })

        expect(results.length).toBe(1)
        expect(results[0].id).toBe(attId)
        expect(results[0].extraction?.fullText).toContain("kubernetes")
      })
    })

    test("filters by content type when specified", async () => {
      const localStreamId = streamId()
      const screenshotAttId = attachmentId()
      const chartAttId = attachmentId()

      await withTestTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })

        // Create screenshot attachment
        await AttachmentRepository.insert(client, {
          id: screenshotAttId,
          workspaceId: testWorkspaceId,
          streamId: localStreamId,
          uploadedBy: testUserId,
          filename: "screen.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          storagePath: "/test/screen",
        })

        await AttachmentExtractionRepository.insert(client, {
          id: extractionId(),
          attachmentId: screenshotAttId,
          workspaceId: testWorkspaceId,
          contentType: "screenshot",
          summary: "Performance metrics dashboard",
        })

        // Create chart attachment
        await AttachmentRepository.insert(client, {
          id: chartAttId,
          workspaceId: testWorkspaceId,
          streamId: localStreamId,
          uploadedBy: testUserId,
          filename: "chart.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          storagePath: "/test/chart",
        })

        await AttachmentExtractionRepository.insert(client, {
          id: extractionId(),
          attachmentId: chartAttId,
          workspaceId: testWorkspaceId,
          contentType: "chart",
          summary: "Performance metrics chart",
        })

        // Search with content type filter for charts only
        const results = await AttachmentRepository.searchWithExtractions(client, {
          workspaceId: testWorkspaceId,
          streamIds: [localStreamId],
          query: "metrics",
          contentTypes: ["chart"] as ExtractionContentType[],
        })

        expect(results.length).toBe(1)
        expect(results[0].id).toBe(chartAttId)
        expect(results[0].extraction?.contentType).toBe("chart")
      })
    })

    test("respects limit parameter", async () => {
      const localStreamId = streamId()

      await withTestTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })

        // Create 5 attachments
        for (let i = 0; i < 5; i++) {
          await AttachmentRepository.insert(client, {
            id: attachmentId(),
            workspaceId: testWorkspaceId,
            streamId: localStreamId,
            uploadedBy: testUserId,
            filename: `report-${i}.pdf`,
            mimeType: "application/pdf",
            sizeBytes: 1024,
            storagePath: `/test/report-${i}`,
          })
        }

        const results = await AttachmentRepository.searchWithExtractions(client, {
          workspaceId: testWorkspaceId,
          streamIds: [localStreamId],
          query: "report",
          limit: 3,
        })

        expect(results.length).toBe(3)
      })
    })

    test("only searches within specified streams", async () => {
      const stream1Id = streamId()
      const stream2Id = streamId()
      const att1Id = attachmentId()
      const att2Id = attachmentId()

      await withTestTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: stream1Id,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })

        await StreamRepository.insert(client, {
          id: stream2Id,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })

        await AttachmentRepository.insert(client, {
          id: att1Id,
          workspaceId: testWorkspaceId,
          streamId: stream1Id,
          uploadedBy: testUserId,
          filename: "secret-doc.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/secret1",
        })

        await AttachmentRepository.insert(client, {
          id: att2Id,
          workspaceId: testWorkspaceId,
          streamId: stream2Id,
          uploadedBy: testUserId,
          filename: "secret-file.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/secret2",
        })

        // Search only in stream1
        const results = await AttachmentRepository.searchWithExtractions(client, {
          workspaceId: testWorkspaceId,
          streamIds: [stream1Id],
          query: "secret",
        })

        expect(results.length).toBe(1)
        expect(results[0].id).toBe(att1Id)
      })
    })

    test("returns results ordered by created_at descending", async () => {
      const localStreamId = streamId()

      await withTestTransaction(pool, async (client) => {
        await StreamRepository.insert(client, {
          id: localStreamId,
          workspaceId: testWorkspaceId,
          type: "channel",
          visibility: "public",
          companionMode: "off",
          createdBy: testUserId,
        })

        const ids: string[] = []
        for (let i = 0; i < 3; i++) {
          const id = attachmentId()
          ids.push(id)
          await AttachmentRepository.insert(client, {
            id,
            workspaceId: testWorkspaceId,
            streamId: localStreamId,
            uploadedBy: testUserId,
            filename: `test-file-${i}.pdf`,
            mimeType: "application/pdf",
            sizeBytes: 1024,
            storagePath: `/test/file-${i}`,
          })
          // Manually set created_at to ensure different timestamps
          // (NOW() within a transaction returns transaction start time)
          await client.query(`UPDATE attachments SET created_at = NOW() - INTERVAL '${3 - i} seconds' WHERE id = $1`, [
            id,
          ])
        }

        const results = await AttachmentRepository.searchWithExtractions(client, {
          workspaceId: testWorkspaceId,
          streamIds: [localStreamId],
          query: "test-file",
        })

        expect(results.length).toBe(3)
        // Most recent (last created, smallest interval subtracted) should be first
        expect(results[0].id).toBe(ids[2])
        expect(results[1].id).toBe(ids[1])
        expect(results[2].id).toBe(ids[0])
      })
    })
  })
})
