import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Pool } from "pg"
import { PdfJobStatuses, PdfPageClassifications, ProcessingStatuses } from "@threahq/types"
import { setupTestDatabase } from "./setup"
import {
  AttachmentRepository,
  ExcelProcessingService,
  ImageCaptionService,
  PdfPageExtractionRepository,
  PdfProcessingJobRepository,
  PdfProcessingService,
  StubExcelProcessingService,
  StubImageCaptionService,
  StubPdfProcessingService,
  StubTextProcessingService,
  StubVideoTranscodingService,
  StubWordProcessingService,
  TextProcessingService,
  VideoTranscodeJobRepository,
  WordProcessingService,
  createAttachmentFailedOnDLQ,
  createExcelProcessingWorker,
  createImageCaptionWorker,
  createImageThumbnailWorker,
  createPdfAssembleWorker,
  createPdfPageWorker,
  createPdfPrepareWorker,
  createTextProcessingWorker,
  createVideoTranscodeCheckWorker,
  createVideoTranscodeOnDLQ,
  createVideoTranscodeSubmitWorker,
  createWordProcessingWorker,
} from "../../src/features/attachments"
import { processAttachment } from "../../src/features/attachments/process-attachment"
import {
  AvatarUploadRepository,
  createAvatarProcessOnDLQ,
  createAvatarProcessWorker,
  type AvatarProcessingService,
} from "../../src/features/workspaces"
import {
  JobQueues,
  type JobHandler,
  type OnDLQHook,
  type PdfAssembleJobData,
  type QueueManager,
} from "../../src/lib/queue"
import type { StorageProvider } from "../../src/lib/storage/s3-client"
import {
  attachmentId,
  avatarUploadId,
  pdfJobId,
  pdfPageId,
  userId,
  videoTranscodeJobId,
  workspaceId,
} from "../../src/lib/id"

interface ProcessingJobData {
  attachmentId: string
  workspaceId: string
  filename: string
  mimeType: string
  storagePath: string
}

interface Observed {
  processingStatus: string
  extractions: { workspace_id: string; source_type: string }[]
  pdfJobs: { workspace_id: string; status: string }[]
  pdfPageWorkspaces: string[]
  events: { type: string; workspaceId: string }[]
}

interface Pipeline {
  name: string
  filename: string
  mimeType: string
  run: (data: ProcessingJobData) => Promise<void>
  /** What the stub leaves behind in workspace A once the job ran for it. */
  completed: Partial<Observed> & Pick<Observed, "processingStatus">
  followUps?: (data: { workspaceId: string; attachmentId: string }) => { queue: string; data: unknown }[]
}

const UNTOUCHED: Observed = {
  processingStatus: "pending",
  extractions: [],
  pdfJobs: [],
  pdfPageWorkspaces: [],
  events: [],
}

describe("Attachment processing workers, services and DLQ hooks stay inside the job's workspace (INV-8)", () => {
  let pool: Pool
  let wsA: string
  let wsB: string
  let pipelines: Pipeline[]
  let sent: { queue: string; data: unknown }[] = []

  const jobQueue = {
    send: mock(async (queue: string, data: unknown) => {
      sent.push({ queue, data })
      return null
    }),
  } as unknown as QueueManager

  const asJob =
    <T>(queue: string, worker: JobHandler<T>) =>
    (data: ProcessingJobData) =>
      worker({ id: "job_scope", name: queue, data: data as unknown as T })

  const runJob = <T>(queue: string, worker: JobHandler<T>, data: T) => worker({ id: "job_scope", name: queue, data })

  const runDlq = <T extends { workspaceId: string }>(hook: OnDLQHook<T>, data: T) =>
    hook(pool, { id: "job_dlq", name: "dlq", data }, new Error("retries exhausted"), {
      failedCount: 5,
      insertedAt: new Date(),
      workspaceId: data.workspaceId,
    })

  async function seedAttachment(wid: string, filename: string, mimeType: string) {
    const id = attachmentId()
    await AttachmentRepository.insert(pool, {
      id,
      workspaceId: wid,
      uploadedBy: userId(),
      filename,
      mimeType,
      sizeBytes: 10,
      storagePath: `${wid}/${id}/${filename}`,
      safetyStatus: "clean",
    })
    return id
  }

  async function observe(id: string): Promise<Observed> {
    const attachment = await pool.query(`SELECT processing_status FROM attachments WHERE id = $1`, [id])
    const extractions = await pool.query(
      `SELECT workspace_id, source_type FROM attachment_extractions WHERE attachment_id = $1 ORDER BY id`,
      [id]
    )
    const pdfJobs = await pool.query(
      `SELECT workspace_id, status FROM pdf_processing_jobs WHERE attachment_id = $1 ORDER BY id`,
      [id]
    )
    const pdfPages = await pool.query(
      `SELECT DISTINCT workspace_id FROM pdf_page_extractions WHERE attachment_id = $1 ORDER BY workspace_id`,
      [id]
    )
    const events = await pool.query(
      `SELECT event_type, payload FROM outbox WHERE payload->>'attachmentId' = $1 ORDER BY id`,
      [id]
    )
    return {
      processingStatus: attachment.rows[0].processing_status,
      extractions: extractions.rows,
      pdfJobs: pdfJobs.rows,
      pdfPageWorkspaces: pdfPages.rows.map((row) => row.workspace_id),
      events: events.rows.map((row) => ({ type: row.event_type, workspaceId: row.payload.workspaceId })),
    }
  }

  const jobFor = (pipeline: Pipeline, wid: string, id: string): ProcessingJobData => ({
    attachmentId: id,
    workspaceId: wid,
    filename: pipeline.filename,
    mimeType: pipeline.mimeType,
    storagePath: `${wsA}/${id}/${pipeline.filename}`,
  })

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = workspaceId()
    wsB = workspaceId()

    pipelines = [
      {
        name: "text",
        filename: "notes.txt",
        mimeType: "text/plain",
        run: asJob(
          JobQueues.TEXT_PROCESS,
          createTextProcessingWorker({ textProcessingService: new StubTextProcessingService({ pool }) })
        ),
        completed: { processingStatus: "completed", extractions: [{ workspace_id: wsA, source_type: "text" }] },
      },
      {
        name: "word",
        filename: "memo.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        run: asJob(
          JobQueues.WORD_PROCESS,
          createWordProcessingWorker({ wordProcessingService: new StubWordProcessingService({ pool }) })
        ),
        completed: { processingStatus: "completed", extractions: [{ workspace_id: wsA, source_type: "word" }] },
      },
      {
        name: "excel",
        filename: "sheet.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        run: asJob(
          JobQueues.EXCEL_PROCESS,
          createExcelProcessingWorker({ excelProcessingService: new StubExcelProcessingService({ pool }) })
        ),
        completed: { processingStatus: "completed", extractions: [{ workspace_id: wsA, source_type: "excel" }] },
      },
      {
        name: "image caption",
        filename: "photo.png",
        mimeType: "image/png",
        run: asJob(
          JobQueues.IMAGE_CAPTION,
          createImageCaptionWorker({ imageCaptionService: new StubImageCaptionService(pool) })
        ),
        completed: { processingStatus: "skipped" },
      },
      {
        name: "video transcode submit",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        run: asJob(
          JobQueues.VIDEO_TRANSCODE_SUBMIT,
          createVideoTranscodeSubmitWorker({ videoTranscodingService: new StubVideoTranscodingService(pool), jobQueue })
        ),
        completed: { processingStatus: "skipped", events: [{ type: "attachment:transcoded", workspaceId: wsA }] },
        followUps: (data) => [{ queue: JobQueues.VIDEO_TRANSCODE_CHECK, data }],
      },
      {
        name: "pdf prepare",
        filename: "report.pdf",
        mimeType: "application/pdf",
        run: asJob(
          JobQueues.PDF_PREPARE,
          createPdfPrepareWorker({ pdfProcessingService: new StubPdfProcessingService({ pool }) })
        ),
        completed: {
          processingStatus: "completed",
          extractions: [{ workspace_id: wsA, source_type: "pdf" }],
          pdfJobs: [{ workspace_id: wsA, status: "completed" }],
          pdfPageWorkspaces: [wsA],
          events: [{ type: "attachment:extraction_completed", workspaceId: wsA }],
        },
      },
    ]
  })

  beforeEach(() => {
    sent = []
  })

  afterAll(async () => {
    await pool.end()
  })

  const pipelineNames = ["text", "word", "excel", "image caption", "video transcode submit", "pdf prepare"]
  const pipelineNamed = (name: string) => pipelines.find((pipeline) => pipeline.name === name)!

  test.each(pipelineNames)(
    "should take the %s job to its terminal state in workspace A when the job names workspace A",
    async (name) => {
      const pipeline = pipelineNamed(name)
      const id = await seedAttachment(wsA, pipeline.filename, pipeline.mimeType)

      await pipeline.run(jobFor(pipeline, wsA, id))

      expect({ observed: await observe(id), followUps: sent }).toEqual({
        observed: { ...UNTOUCHED, ...pipeline.completed },
        followUps: pipeline.followUps?.({ workspaceId: wsA, attachmentId: id }) ?? [],
      })
    }
  )

  test.each(pipelineNames)(
    "should leave a workspace A attachment untouched when the %s job names workspace B with its id",
    async (name) => {
      const pipeline = pipelineNamed(name)
      const id = await seedAttachment(wsA, pipeline.filename, pipeline.mimeType)

      await pipeline.run(jobFor(pipeline, wsB, id))

      expect(await observe(id)).toEqual(UNTOUCHED)
    }
  )

  describe("processAttachment", () => {
    const extraction = {
      contentType: "document" as const,
      summary: "scope summary",
      fullText: "scope text",
      structuredData: null,
      sourceType: "text" as const,
    }

    test("should claim, save the extraction and complete the attachment in workspace A when called for workspace A", async () => {
      const id = await seedAttachment(wsA, "doc.txt", "text/plain")
      const callback = mock(async () => extraction)

      await processAttachment(pool, wsA, id, callback)

      expect({ observed: await observe(id), callbackCalls: callback.mock.calls.length }).toEqual({
        observed: {
          ...UNTOUCHED,
          processingStatus: "completed",
          extractions: [{ workspace_id: wsA, source_type: "text" }],
          events: [{ type: "attachment:extraction_completed", workspaceId: wsA }],
        },
        callbackCalls: 1,
      })
    })

    test("should never run the callback or touch a workspace A attachment when called for workspace B with its id", async () => {
      const id = await seedAttachment(wsA, "doc.txt", "text/plain")
      const callback = mock(async () => extraction)

      await processAttachment(pool, wsB, id, callback)

      expect({ observed: await observe(id), callbackCalls: callback.mock.calls.length }).toEqual({
        observed: UNTOUCHED,
        callbackCalls: 0,
      })
    })
  })

  describe("PDF assemble", () => {
    type AssembleTarget = Pick<PdfAssembleJobData, "workspaceId" | "attachmentId" | "pdfJobId">

    const assemblers: Record<string, (target: AssembleTarget) => Promise<void>> = {
      "worker over the stub service": (target) =>
        runJob(
          JobQueues.PDF_ASSEMBLE,
          createPdfAssembleWorker({ pdfProcessingService: new StubPdfProcessingService({ pool }) }),
          target
        ),
      "real service": (target) =>
        new PdfProcessingService({
          pool,
          ai: {} as never,
          storage: {} as never,
          jobQueue: {} as never,
        }).assemble(target.workspaceId, target.attachmentId, target.pdfJobId),
    }

    async function seedPdf() {
      const id = await seedAttachment(wsA, "report.pdf", "application/pdf")
      const jobId = pdfJobId()
      await PdfProcessingJobRepository.insert(pool, {
        id: jobId,
        attachmentId: id,
        workspaceId: wsA,
        totalPages: 2,
        status: PdfJobStatuses.PROCESSING_PAGES,
      })
      for (const pageNumber of [1, 2]) {
        await PdfPageExtractionRepository.insert(pool, {
          id: pdfPageId(),
          attachmentId: id,
          workspaceId: wsA,
          pageNumber,
          classification: PdfPageClassifications.TEXT_RICH,
          rawText: `page ${pageNumber} text`,
          processingStatus: ProcessingStatuses.COMPLETED,
        })
      }
      return { id, jobId }
    }

    test.each(Object.keys(assemblers))(
      "should write the extraction and complete the job and attachment in workspace A when the %s is told workspace A",
      async (name) => {
        const { id, jobId } = await seedPdf()

        await assemblers[name]({ workspaceId: wsA, attachmentId: id, pdfJobId: jobId })

        expect(await observe(id)).toEqual({
          processingStatus: "completed",
          extractions: [{ workspace_id: wsA, source_type: "pdf" }],
          pdfJobs: [{ workspace_id: wsA, status: "completed" }],
          pdfPageWorkspaces: [wsA],
          events: [{ type: "attachment:extraction_completed", workspaceId: wsA }],
        })
      }
    )

    test.each(Object.keys(assemblers))(
      "should leave workspace A's attachment, job and pages untouched when the %s is told workspace B with their ids",
      async (name) => {
        const { id, jobId } = await seedPdf()

        await assemblers[name]({ workspaceId: wsB, attachmentId: id, pdfJobId: jobId })

        expect(await observe(id)).toEqual({
          ...UNTOUCHED,
          pdfJobs: [{ workspace_id: wsA, status: "processing_pages" }],
          pdfPageWorkspaces: [wsA],
        })
      }
    )
  })

  describe("workers hand the job's workspace and ids to their service in order", () => {
    const job = { workspaceId: "ws_job", attachmentId: "attach_job" }
    let calls: { method: string; args: unknown[] }[]

    beforeEach(() => {
      calls = []
    })

    const record =
      (method: string) =>
      async (...args: unknown[]) => {
        calls.push({ method, args })
      }

    const rows: Record<
      string,
      { run: () => Promise<void>; expected: { calls: typeof calls; reEnqueued: typeof sent } }
    > = {
      "pdf page": {
        run: () =>
          runJob(
            JobQueues.PDF_PROCESS_PAGE,
            createPdfPageWorker({
              pdfProcessingService: {
                prepare: record("prepare"),
                processPage: record("processPage"),
                assemble: record("assemble"),
              },
            }),
            { ...job, pageNumber: 3, pdfJobId: "pdfjob_job" }
          ),
        expected: {
          calls: [{ method: "processPage", args: ["ws_job", "attach_job", 3, "pdfjob_job"] }],
          reEnqueued: [],
        },
      },
      "video transcode check": {
        run: () =>
          runJob(
            JobQueues.VIDEO_TRANSCODE_CHECK,
            createVideoTranscodeCheckWorker({
              videoTranscodingService: {
                submit: record("submit"),
                checkStatus: async (...args) => {
                  calls.push({ method: "checkStatus", args })
                  return false
                },
              },
              jobQueue,
            }),
            job
          ),
        expected: {
          calls: [{ method: "checkStatus", args: ["ws_job", "attach_job"] }],
          reEnqueued: [
            { queue: JobQueues.VIDEO_TRANSCODE_CHECK, data: { workspaceId: "ws_job", attachmentId: "attach_job" } },
          ],
        },
      },
      "image thumbnail": {
        run: () =>
          runJob(
            JobQueues.IMAGE_THUMBNAIL,
            createImageThumbnailWorker({ imageThumbnailService: { generateThumbnail: record("generateThumbnail") } }),
            { ...job, filename: "photo.png", mimeType: "image/png", storagePath: "ws_job/attach_job/photo.png" }
          ),
        expected: {
          calls: [{ method: "generateThumbnail", args: ["ws_job", "attach_job"] }],
          reEnqueued: [],
        },
      },
      "avatar process": {
        run: () =>
          runJob(
            JobQueues.AVATAR_PROCESS,
            createAvatarProcessWorker({
              avatarProcessingService: { processUpload: record("processUpload") } as unknown as AvatarProcessingService,
            }),
            { workspaceId: "ws_job", avatarUploadId: "avatar_job" }
          ),
        expected: {
          calls: [{ method: "processUpload", args: ["ws_job", "avatar_job"] }],
          reEnqueued: [],
        },
      },
    }

    test.each(Object.keys(rows))(
      "should pass the job's ids to the service in order when the %s worker runs",
      async (name) => {
        await rows[name].run()

        expect({ calls, reEnqueued: sent }).toEqual(rows[name].expected)
      }
    )
  })

  describe("real processing services claim the attachment with the job's pair", () => {
    function storageThatRejects() {
      const reads: string[] = []
      const reject = async (path: string) => {
        reads.push(path)
        throw new Error("storage reached")
      }
      return { reads, storage: { getObject: reject, getObjectRange: reject } as unknown as StorageProvider }
    }

    const services: Record<
      string,
      { filename: string; mimeType: string; run: (storage: StorageProvider, wid: string, id: string) => Promise<void> }
    > = {
      text: {
        filename: "notes.txt",
        mimeType: "text/plain",
        run: (storage, wid, id) => new TextProcessingService({ pool, ai: {} as never, storage }).processText(wid, id),
      },
      word: {
        filename: "memo.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        run: (storage, wid, id) => new WordProcessingService({ pool, ai: {} as never, storage }).processWord(wid, id),
      },
      excel: {
        filename: "sheet.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        run: (storage, wid, id) => new ExcelProcessingService({ pool, ai: {} as never, storage }).processExcel(wid, id),
      },
      "image caption": {
        filename: "photo.png",
        mimeType: "image/png",
        run: (storage, wid, id) =>
          new ImageCaptionService({ pool, ai: {} as never, storage, configResolver: {} as never }).processImage(
            wid,
            id
          ),
      },
    }

    const outcomeOf = (run: Promise<void>) =>
      run.then(
        () => "resolved",
        (error: Error) => error.message
      )

    test.each(Object.keys(services))(
      "should reach storage with workspace A's row when the %s service is told workspace A",
      async (name) => {
        const { filename, mimeType, run } = services[name]
        const { reads, storage } = storageThatRejects()
        const id = await seedAttachment(wsA, filename, mimeType)

        const outcome = await outcomeOf(run(storage, wsA, id))

        expect({ outcome, reads, observed: await observe(id) }).toEqual({
          outcome: "storage reached",
          reads: [`${wsA}/${id}/${filename}`],
          observed: { ...UNTOUCHED, processingStatus: "processing" },
        })
      }
    )

    test.each(Object.keys(services))(
      "should never reach storage or touch workspace A's attachment when the %s service is told workspace B with its id",
      async (name) => {
        const { filename, mimeType, run } = services[name]
        const { reads, storage } = storageThatRejects()
        const id = await seedAttachment(wsA, filename, mimeType)

        const outcome = await outcomeOf(run(storage, wsB, id))

        expect({ outcome, reads, observed: await observe(id) }).toEqual({
          outcome: "resolved",
          reads: [],
          observed: UNTOUCHED,
        })
      }
    )
  })

  describe("DLQ hooks", () => {
    async function observeVideoJobs(id: string) {
      const result = await pool.query(
        `SELECT workspace_id, status, error_message FROM video_transcode_jobs WHERE attachment_id = $1 ORDER BY id`,
        [id]
      )
      return result.rows
    }

    async function seedVideo() {
      const id = await seedAttachment(wsA, "clip.mp4", "video/mp4")
      await VideoTranscodeJobRepository.insert(pool, { id: videoTranscodeJobId(), attachmentId: id, workspaceId: wsA })
      return id
    }

    async function observeAvatarUploads(id: string) {
      const result = await pool.query(`SELECT workspace_id FROM avatar_uploads WHERE id = $1`, [id])
      return result.rows
    }

    async function seedAvatarUpload() {
      const id = avatarUploadId()
      await AvatarUploadRepository.insert(pool, {
        id,
        workspaceId: wsA,
        userId: userId(),
        rawS3Key: `avatar/${id}`,
        replacesAvatarUrl: null,
      })
      return id
    }

    test("should mark workspace A's attachment failed when the attachment hook gets a workspace A job", async () => {
      const id = await seedAttachment(wsA, "notes.txt", "text/plain")

      await runDlq(createAttachmentFailedOnDLQ(), { workspaceId: wsA, attachmentId: id })

      expect(await observe(id)).toEqual({ ...UNTOUCHED, processingStatus: "failed" })
    })

    test("should leave workspace A's attachment untouched when the attachment hook gets a workspace B job with its id", async () => {
      const id = await seedAttachment(wsA, "notes.txt", "text/plain")

      await runDlq(createAttachmentFailedOnDLQ(), { workspaceId: wsB, attachmentId: id })

      expect(await observe(id)).toEqual(UNTOUCHED)
    })

    test("should fail the attachment and video job and announce it in workspace A when the video hook gets a workspace A job", async () => {
      const id = await seedVideo()

      await runDlq(createVideoTranscodeOnDLQ("Moved to DLQ in scope test"), { workspaceId: wsA, attachmentId: id })

      expect({ observed: await observe(id), videoJobs: await observeVideoJobs(id) }).toEqual({
        observed: {
          ...UNTOUCHED,
          processingStatus: "failed",
          events: [{ type: "attachment:transcoded", workspaceId: wsA }],
        },
        videoJobs: [{ workspace_id: wsA, status: "failed", error_message: "Moved to DLQ in scope test" }],
      })
    })

    test("should leave workspace A's attachment and video job untouched and announce nothing when the video hook gets a workspace B job with their id", async () => {
      const id = await seedVideo()

      await runDlq(createVideoTranscodeOnDLQ("Moved to DLQ in scope test"), { workspaceId: wsB, attachmentId: id })

      expect({ observed: await observe(id), videoJobs: await observeVideoJobs(id) }).toEqual({
        observed: UNTOUCHED,
        videoJobs: [{ workspace_id: wsA, status: "pending", error_message: null }],
      })
    })

    test("should delete workspace A's avatar upload row when the avatar hook gets a workspace A job", async () => {
      const id = await seedAvatarUpload()

      await runDlq(createAvatarProcessOnDLQ(), { workspaceId: wsA, avatarUploadId: id })

      expect(await observeAvatarUploads(id)).toEqual([])
    })

    test("should keep workspace A's avatar upload row when the avatar hook gets a workspace B job with its id", async () => {
      const id = await seedAvatarUpload()

      await runDlq(createAvatarProcessOnDLQ(), { workspaceId: wsB, avatarUploadId: id })

      expect(await observeAvatarUploads(id)).toEqual([{ workspace_id: wsA }])
    })
  })
})
