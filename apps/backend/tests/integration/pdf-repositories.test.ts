/**
 * PDF Repository Integration Tests
 *
 * Tests verify:
 * 1. PdfPageExtractionRepository CRUD operations
 * 2. PdfProcessingJobRepository CRUD and atomic operations
 * 3. Coordination between repositories
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTestTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import {
  AttachmentRepository,
  PdfPageExtractionRepository,
  PdfProcessingJobRepository,
} from "../../src/features/attachments"
import { userId, workspaceId, streamId, attachmentId, pdfPageId, pdfJobId } from "../../src/lib/id"
import { ProcessingStatuses, PdfJobStatuses, PdfPageClassifications } from "@threahq/types"

describe("PDF Repositories", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string
  let testAttachmentId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()
    testAttachmentId = attachmentId()

    await withTestTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "PDF Test Workspace",
        slug: `pdf-test-${testWorkspaceId}`,
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

  describe("PdfPageExtractionRepository", () => {
    test("inserts and retrieves a page extraction", async () => {
      const attId = attachmentId()
      const pageId = pdfPageId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "document.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/document.pdf",
        })

        const inserted = await PdfPageExtractionRepository.insert(client, {
          id: pageId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          pageNumber: 1,
          classification: "text_rich",
          rawText: "This is the extracted text from page 1",
        })

        expect(inserted.id).toBe(pageId)
        expect(inserted.attachmentId).toBe(attId)
        expect(inserted.pageNumber).toBe(1)
        expect(inserted.classification).toBe("text_rich")
        expect(inserted.rawText).toBe("This is the extracted text from page 1")
        expect(inserted.processingStatus).toBe("pending")

        const found = await PdfPageExtractionRepository.findById(client, pageId)
        expect(found).not.toBeNull()
        expect(found!.id).toBe(pageId)
      })
    })

    test("inserts many pages in batch", async () => {
      const attId = attachmentId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "multi-page.pdf",
          mimeType: "application/pdf",
          sizeBytes: 5000,
          storagePath: "/test/multi-page.pdf",
        })

        const pages = [
          {
            id: pdfPageId(),
            attachmentId: attId,
            workspaceId: testWorkspaceId,
            pageNumber: 1,
            classification: "text_rich" as const,
            rawText: "Page 1 content",
          },
          {
            id: pdfPageId(),
            attachmentId: attId,
            workspaceId: testWorkspaceId,
            pageNumber: 2,
            classification: "scanned" as const,
          },
          {
            id: pdfPageId(),
            attachmentId: attId,
            workspaceId: testWorkspaceId,
            pageNumber: 3,
            classification: "complex_layout" as const,
          },
        ]

        const count = await PdfPageExtractionRepository.insertMany(client, pages)
        expect(count).toBe(3)

        const found = await PdfPageExtractionRepository.findByAttachmentId(client, attId)
        expect(found.length).toBe(3)
        expect(found.map((p) => p.pageNumber)).toEqual([1, 2, 3])
      })
    })

    test("finds pages by attachment and page range", async () => {
      const attId = attachmentId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "large-doc.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10000,
          storagePath: "/test/large-doc.pdf",
        })

        const pages = Array.from({ length: 10 }, (_, i) => ({
          id: pdfPageId(),
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          pageNumber: i + 1,
          classification: "text_rich" as const,
          rawText: `Page ${i + 1} content`,
        }))

        await PdfPageExtractionRepository.insertMany(client, pages)

        const range = await PdfPageExtractionRepository.findByAttachmentAndPageRange(client, attId, 3, 7)
        expect(range.length).toBe(5)
        expect(range.map((p) => p.pageNumber)).toEqual([3, 4, 5, 6, 7])
      })
    })

    test("updates processing status with conditions", async () => {
      const attId = attachmentId()
      const pageId = pdfPageId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "status-test.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/status-test.pdf",
        })

        await PdfPageExtractionRepository.insert(client, {
          id: pageId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          pageNumber: 1,
          classification: "text_rich",
          processingStatus: "pending",
        })

        // Update should succeed when status matches
        const updated = await PdfPageExtractionRepository.updateProcessingStatus(
          client,
          pageId,
          ProcessingStatuses.PROCESSING,
          { onlyIfStatusIn: [ProcessingStatuses.PENDING] }
        )
        expect(updated).toBe(true)

        // Update should fail when status doesn't match
        const notUpdated = await PdfPageExtractionRepository.updateProcessingStatus(
          client,
          pageId,
          ProcessingStatuses.COMPLETED,
          { onlyIfStatusIn: [ProcessingStatuses.PENDING] }
        )
        expect(notUpdated).toBe(false)
      })
    })

    test("counts pages by status", async () => {
      const attId = attachmentId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "count-test.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/count-test.pdf",
        })

        const pages = [
          {
            id: pdfPageId(),
            attachmentId: attId,
            workspaceId: testWorkspaceId,
            pageNumber: 1,
            classification: "text_rich" as const,
            processingStatus: "pending" as const,
          },
          {
            id: pdfPageId(),
            attachmentId: attId,
            workspaceId: testWorkspaceId,
            pageNumber: 2,
            classification: "text_rich" as const,
            processingStatus: "completed" as const,
          },
          {
            id: pdfPageId(),
            attachmentId: attId,
            workspaceId: testWorkspaceId,
            pageNumber: 3,
            classification: "text_rich" as const,
            processingStatus: "completed" as const,
          },
          {
            id: pdfPageId(),
            attachmentId: attId,
            workspaceId: testWorkspaceId,
            pageNumber: 4,
            classification: "text_rich" as const,
            processingStatus: "failed" as const,
          },
        ]

        await PdfPageExtractionRepository.insertMany(client, pages)

        const counts = await PdfPageExtractionRepository.countByStatus(client, attId)
        expect(counts).toMatchObject({
          pending: 1,
          completed: 2,
          failed: 1,
          processing: 0,
        })
      })
    })
  })

  describe("PdfProcessingJobRepository", () => {
    test("inserts and retrieves a processing job", async () => {
      const attId = attachmentId()
      const jobId = pdfJobId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "job-test.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/job-test.pdf",
        })

        const inserted = await PdfProcessingJobRepository.insert(client, {
          id: jobId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          totalPages: 10,
          status: PdfJobStatuses.PREPARING,
        })

        expect(inserted.id).toBe(jobId)
        expect(inserted.attachmentId).toBe(attId)
        expect(inserted.totalPages).toBe(10)
        expect(inserted.pagesCompleted).toBe(0)
        expect(inserted.pagesFailed).toBe(0)
        expect(inserted.status).toBe("preparing")

        const found = await PdfProcessingJobRepository.findById(client, jobId)
        expect(found).not.toBeNull()
        expect(found!.id).toBe(jobId)
      })
    })

    test("finds job by attachment ID", async () => {
      const attId = attachmentId()
      const jobId = pdfJobId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "find-test.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/find-test.pdf",
        })

        await PdfProcessingJobRepository.insert(client, {
          id: jobId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          totalPages: 5,
          status: PdfJobStatuses.PROCESSING_PAGES,
        })

        const found = await PdfProcessingJobRepository.findByAttachmentId(client, attId)
        expect(found).not.toBeNull()
        expect(found!.id).toBe(jobId)
        expect(found!.status).toBe("processing_pages")
      })
    })

    test("atomically increments pages completed", async () => {
      const attId = attachmentId()
      const jobId = pdfJobId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "increment-test.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/increment-test.pdf",
        })

        await PdfProcessingJobRepository.insert(client, {
          id: jobId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          totalPages: 5,
          status: PdfJobStatuses.PROCESSING_PAGES,
        })

        // Increment completed pages
        const result1 = await PdfProcessingJobRepository.incrementPagesCompleted(client, jobId)
        expect(result1.pagesCompleted).toBe(1)
        expect(result1.pagesFailed).toBe(0)
        expect(result1.totalPages).toBe(5)

        const result2 = await PdfProcessingJobRepository.incrementPagesCompleted(client, jobId)
        expect(result2.pagesCompleted).toBe(2)

        const result3 = await PdfProcessingJobRepository.incrementPagesCompleted(client, jobId)
        expect(result3.pagesCompleted).toBe(3)
      })
    })

    test("atomically increments pages failed", async () => {
      const attId = attachmentId()
      const jobId = pdfJobId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "fail-test.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/fail-test.pdf",
        })

        await PdfProcessingJobRepository.insert(client, {
          id: jobId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          totalPages: 5,
          status: PdfJobStatuses.PROCESSING_PAGES,
        })

        const result = await PdfProcessingJobRepository.incrementPagesFailed(client, jobId)
        expect(result.pagesFailed).toBe(1)
        expect(result.pagesCompleted).toBe(0)
      })
    })

    test("updates job status", async () => {
      const attId = attachmentId()
      const jobId = pdfJobId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "status-update.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/status-update.pdf",
        })

        await PdfProcessingJobRepository.insert(client, {
          id: jobId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          totalPages: 5,
          status: PdfJobStatuses.PREPARING,
        })

        const updated = await PdfProcessingJobRepository.updateStatus(client, jobId, PdfJobStatuses.COMPLETED)
        expect(updated).toBe(true)

        const found = await PdfProcessingJobRepository.findById(client, jobId)
        expect(found).not.toBeNull()
        expect(found!.status).toBe("completed")
        expect(found!.completedAt).not.toBeNull()
      })
    })

    test("updates job status with error message on failure", async () => {
      const attId = attachmentId()
      const jobId = pdfJobId()

      await withTestTransaction(pool, async (client) => {
        await AttachmentRepository.insert(client, {
          id: attId,
          workspaceId: testWorkspaceId,
          streamId: testStreamId,
          uploadedBy: testUserId,
          filename: "error-test.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          storagePath: "/test/error-test.pdf",
        })

        await PdfProcessingJobRepository.insert(client, {
          id: jobId,
          attachmentId: attId,
          workspaceId: testWorkspaceId,
          totalPages: 5,
          status: PdfJobStatuses.PROCESSING_PAGES,
        })

        const updated = await PdfProcessingJobRepository.updateStatus(client, jobId, PdfJobStatuses.FAILED, {
          errorMessage: "Failed to process page 3",
        })
        expect(updated).toBe(true)

        const found = await PdfProcessingJobRepository.findById(client, jobId)
        expect(found).not.toBeNull()
        expect(found!.status).toBe("failed")
        expect(found!.errorMessage).toBe("Failed to process page 3")
      })
    })
  })
})
