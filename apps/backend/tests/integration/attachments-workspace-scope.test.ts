import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import {
  AttachmentExtractionRepository,
  AttachmentRepository,
  AttachmentUploadRepository,
  PdfPageExtractionRepository,
  PdfProcessingJobRepository,
  VideoTranscodeJobRepository,
} from "../../src/features/attachments"
import { AvatarUploadRepository, WorkspaceRepository } from "../../src/features/workspaces"
import {
  attachmentId,
  attachmentReferenceId,
  attachmentUploadId,
  avatarUploadId,
  extractionId,
  messageId,
  pdfJobId,
  pdfPageId,
  personaId,
  streamId,
  userId,
  videoTranscodeJobId,
  workspaceId,
} from "../../src/lib/id"

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
// The sweeps cover every workspace in a shared database: seeded rows sit in the year 2000 and the cutoff
// follows it, so no other test's rows qualify.
const LONG_AGO = new Date("2000-01-01T00:00:00Z")
const SWEEP_CUTOFF = new Date("2000-01-02T00:00:00Z")
const token = () => `tok${Math.random().toString(36).slice(2, 12)}`

interface AttachmentSeed {
  streamId?: string
  messageId?: string
  uploadedBy?: string
  filename?: string
  processingStatus?: string
  safetyStatus?: string
  createdAt?: Date
}

describe("Attachments, uploads, extractions, PDF/video jobs and avatar uploads workspace scope (INV-8)", () => {
  let pool: Pool
  let wsA: string
  let wsB: string
  let userA: { id: string; slug: string; name: string }
  let userB: { id: string; slug: string; name: string }
  let streamA: string

  async function insertRow(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row)
    await pool.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row)
    )
  }

  async function rowsOf(table: string, column: string, value: string) {
    const result = await pool.query(`SELECT * FROM ${table} WHERE ${column} = $1`, [value])
    return result.rows
  }

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Attachments scope ${label}`,
        slug: `attachments-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    return id
  }

  async function seedMember(wid: string) {
    return withTransaction(pool, async (client) => {
      const member = await addTestMember(client, wid, userId())
      return { id: member.id, slug: member.slug, name: member.name }
    })
  }

  async function addPublicChannel(wid: string, creator: string) {
    const id = streamId()
    await insertRow("streams", {
      id,
      workspace_id: wid,
      type: "channel",
      slug: `attachments-scope-${id}`,
      visibility: "public",
      created_by: creator,
    })
    return id
  }

  async function addAttachment(wid: string, seed: AttachmentSeed = {}) {
    const id = attachmentId()
    await insertRow("attachments", {
      id,
      workspace_id: wid,
      stream_id: seed.streamId ?? null,
      message_id: seed.messageId ?? null,
      uploaded_by: seed.uploadedBy ?? null,
      filename: seed.filename ?? `${id}.png`,
      mime_type: "image/png",
      size_bytes: 10,
      storage_path: `scope/${id}`,
      processing_status: seed.processingStatus ?? "pending",
      safety_status: seed.safetyStatus ?? "clean",
      created_at: seed.createdAt ?? new Date(),
    })
    return id
  }

  async function addExtraction(wid: string, attachment: string, seed: { contentType?: string; summary?: string } = {}) {
    const id = extractionId()
    await insertRow("attachment_extractions", {
      id,
      attachment_id: attachment,
      workspace_id: wid,
      content_type: seed.contentType ?? "chart",
      summary: seed.summary ?? `summary ${id}`,
    })
    return id
  }

  async function addUpload(wid: string, attachment: string, seed: { status?: string; updatedAt?: Date } = {}) {
    const id = attachmentUploadId()
    await insertRow("attachment_uploads", {
      id,
      workspace_id: wid,
      attachment_id: attachment,
      uploaded_by: userA.id,
      status: seed.status ?? "reserved",
      expected_size_bytes: 10,
      ...(seed.updatedAt ? { updated_at: seed.updatedAt } : {}),
    })
    return id
  }

  async function addPdfJob(wid: string, seed: { totalPages?: number; pagesCompleted?: number } = {}) {
    const id = pdfJobId()
    await insertRow("pdf_processing_jobs", {
      id,
      attachment_id: attachmentId(),
      workspace_id: wid,
      total_pages: seed.totalPages ?? 4,
      pages_completed: seed.pagesCompleted ?? 0,
      status: "preparing",
    })
    return id
  }

  async function addPdfPage(wid: string, attachment: string, pageNumber: number) {
    const id = pdfPageId()
    await insertRow("pdf_page_extractions", {
      id,
      attachment_id: attachment,
      workspace_id: wid,
      page_number: pageNumber,
      classification: "text_rich",
      processing_status: "pending",
    })
    return id
  }

  async function addVideoJob(wid: string, attachment: string = attachmentId()) {
    const id = videoTranscodeJobId()
    await insertRow("video_transcode_jobs", { id, attachment_id: attachment, workspace_id: wid, status: "pending" })
    return id
  }

  async function addAvatarUpload(wid: string, user: string) {
    const id = avatarUploadId()
    await insertRow("avatar_uploads", { id, workspace_id: wid, user_id: user, raw_s3_key: `avatar/${id}` })
    return id
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    userA = await seedMember(wsA)
    userB = await seedMember(wsB)
    streamA = await addPublicChannel(wsA, userA.id)
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("AttachmentRepository reads", () => {
    test("should not find a workspace B attachment by id when asked from workspace A", async () => {
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)

      expect(await AttachmentRepository.findById(pool, wsA, b)).toBeNull()
      expect((await AttachmentRepository.findById(pool, wsA, a))?.id).toBe(a)
    })

    test("should return only workspace A attachments when an id list also names a workspace B one", async () => {
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)

      const found = await AttachmentRepository.findByIds(pool, wsA, [a, b])

      expect(found.map((attachment) => attachment.id)).toEqual([a])
    })

    test("should not lock a workspace B attachment when asked from workspace A", async () => {
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)

      expect(await AttachmentRepository.findByIdForUpdate(pool, wsA, b)).toBeNull()
      expect((await AttachmentRepository.findByIdForUpdate(pool, wsA, a))?.id).toBe(a)
    })

    test("should return only workspace A attachments of a message when a workspace B attachment points at the same message id", async () => {
      const message = messageId()
      const a = await addAttachment(wsA, { messageId: message })
      await addAttachment(wsB, { messageId: message })

      const found = await AttachmentRepository.findByMessageId(pool, wsA, message)

      expect(found.map((attachment) => attachment.id)).toEqual([a])
    })

    test("should group only workspace A attachments by message when workspace B attachments point at the same message ids", async () => {
      const shared = messageId()
      const onlyB = messageId()
      const a = await addAttachment(wsA, { messageId: shared })
      await addAttachment(wsB, { messageId: shared })
      await addAttachment(wsB, { messageId: onlyB })

      const found = await AttachmentRepository.findByMessageIds(pool, wsA, [shared, onlyB])

      expect(
        Object.fromEntries([...found].map(([message, list]) => [message, list.map((attachment) => attachment.id)]))
      ).toEqual({ [shared]: [a] })
    })

    test("should join only workspace A extractions when a message's attachments are listed with their extractions", async () => {
      const message = messageId()
      const withOwn = await addAttachment(wsA, { messageId: message })
      const withForeign = await addAttachment(wsA, { messageId: message })
      await addAttachment(wsB, { messageId: message })
      await addExtraction(wsA, withOwn, { contentType: "chart", summary: "own summary" })
      await addExtraction(wsB, withForeign, { contentType: "photo", summary: "foreign summary" })

      const found = await AttachmentRepository.findByMessageIdsWithExtractions(pool, wsA, [message])

      expect(
        (found.get(message) ?? [])
          .map((attachment) => ({ id: attachment.id, extraction: attachment.extraction }))
          .sort((left, right) => left.id.localeCompare(right.id))
      ).toEqual(
        [
          { id: withOwn, extraction: { contentType: "chart" as const, summary: "own summary", fullText: null } },
          { id: withForeign, extraction: null },
        ].sort((left, right) => left.id.localeCompare(right.id))
      )
    })
  })

  describe("AttachmentRepository writes", () => {
    test("should bind only workspace A attachments when an id list also names a workspace B one", async () => {
      const message = messageId()
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)
      const bBefore = await rowsOf("attachments", "id", b)

      const bound = await AttachmentRepository.attachToMessage(pool, wsA, [a, b], message, streamA)

      expect({
        bound,
        a: (await rowsOf("attachments", "id", a)).map((row) => ({ message: row.message_id, stream: row.stream_id })),
        b: await rowsOf("attachments", "id", b),
      }).toEqual({ bound: 1, a: [{ message, stream: streamA }], b: bBefore })
    })

    test("should not delete a workspace B attachment when asked from workspace A", async () => {
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)
      const bBefore = await rowsOf("attachments", "id", b)

      const deleted = {
        foreign: await AttachmentRepository.delete(pool, wsA, b),
        own: await AttachmentRepository.delete(pool, wsA, a),
      }

      expect({ deleted, a: await rowsOf("attachments", "id", a), b: await rowsOf("attachments", "id", b) }).toEqual({
        deleted: { foreign: false, own: true },
        a: [],
        b: bBefore,
      })
    })

    test("should not delete an unbound workspace B attachment when asked from workspace A", async () => {
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)
      const bBefore = await rowsOf("attachments", "id", b)

      const paths = {
        foreign: await AttachmentRepository.deleteIfUnbound(pool, wsA, b),
        own: await AttachmentRepository.deleteIfUnbound(pool, wsA, a),
      }

      expect({ paths, b: await rowsOf("attachments", "id", b) }).toEqual({
        paths: { foreign: null, own: `scope/${a}` },
        b: bBefore,
      })
    })

    test("should keep a workspace B persona binding when workspace A deletes the bindings of that attachment id", async () => {
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)
      const persona = personaId()
      await insertRow("persona_attachments", {
        attachment_id: a,
        workspace_id: wsA,
        persona_id: persona,
        position: 0,
        created_by: userA.id,
      })
      await insertRow("persona_attachments", {
        attachment_id: b,
        workspace_id: wsB,
        persona_id: persona,
        position: 0,
        created_by: userB.id,
      })
      const bBefore = await rowsOf("persona_attachments", "attachment_id", b)

      await AttachmentRepository.deletePersonaBindings(pool, wsA, b)
      await AttachmentRepository.deletePersonaBindings(pool, wsA, a)

      expect({
        a: await rowsOf("persona_attachments", "attachment_id", a),
        b: await rowsOf("persona_attachments", "attachment_id", b),
      }).toEqual({ a: [], b: bBefore })
    })

    test("should delete only unattached workspace A attachments when an id list also names a workspace B one", async () => {
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)
      const bBefore = await rowsOf("attachments", "id", b)

      const deleted = await AttachmentRepository.deleteUnattachedByIds(pool, wsA, [a, b])

      expect({ deleted, a: await rowsOf("attachments", "id", a), b: await rowsOf("attachments", "id", b) }).toEqual({
        deleted: 1,
        a: [],
        b: bBefore,
      })
    })

    test.each([
      ["unconditionally", undefined],
      ["guarded by one status", { onlyIfStatus: "pending" as const }],
      ["guarded by a status list", { onlyIfStatusIn: ["pending" as const] }],
    ])(
      "should not move a workspace B attachment's processing status when asked %s from workspace A",
      async (_, options) => {
        const a = await addAttachment(wsA, { processingStatus: "pending" })
        const b = await addAttachment(wsB, { processingStatus: "pending" })
        const bBefore = await rowsOf("attachments", "id", b)

        const moved = {
          foreign: await AttachmentRepository.updateProcessingStatus(pool, wsA, b, "completed", options),
          own: await AttachmentRepository.updateProcessingStatus(pool, wsA, a, "completed", options),
        }

        expect({
          moved,
          a: (await rowsOf("attachments", "id", a)).map((row) => row.processing_status),
          b: await rowsOf("attachments", "id", b),
        }).toEqual({ moved: { foreign: false, own: true }, a: ["completed"], b: bBefore })
      }
    )

    test("should not rewrite the image variant of a workspace B attachment when asked from workspace A", async () => {
      const a = await addAttachment(wsA)
      const b = await addAttachment(wsB)
      const bBefore = await rowsOf("attachments", "id", b)
      const variant = { thumbnailStoragePath: "scope/thumb.webp", width: 64, height: 32 }

      const updated = {
        foreign: await AttachmentRepository.updateImageVariant(pool, wsA, b, variant),
        own: await AttachmentRepository.updateImageVariant(pool, wsA, a, variant),
      }

      expect({
        updated,
        a: (await rowsOf("attachments", "id", a)).map((row) => [row.thumbnail_storage_path, row.width, row.height]),
        b: await rowsOf("attachments", "id", b),
      }).toEqual({ updated: { foreign: false, own: true }, a: [["scope/thumb.webp", 64, 32]], b: bBefore })
    })

    test.each([
      ["unconditionally", undefined],
      ["guarded by one status", { onlyIfStatus: "pending_scan" as const }],
      ["guarded by a status list", { onlyIfStatusIn: ["pending_scan" as const] }],
    ])(
      "should not move a workspace B attachment's safety status when asked %s from workspace A",
      async (_, options) => {
        const a = await addAttachment(wsA, { safetyStatus: "pending_scan" })
        const b = await addAttachment(wsB, { safetyStatus: "pending_scan" })
        const bBefore = await rowsOf("attachments", "id", b)

        const moved = {
          foreign: await AttachmentRepository.updateSafetyStatus(pool, wsA, b, "clean", options),
          own: await AttachmentRepository.updateSafetyStatus(pool, wsA, a, "clean", options),
        }

        expect({
          moved,
          a: (await rowsOf("attachments", "id", a)).map((row) => row.safety_status),
          b: await rowsOf("attachments", "id", b),
        }).toEqual({ moved: { foreign: false, own: true }, a: ["clean"], b: bBefore })
      }
    )

    test("should quarantine only the attachments whose workspace and id both match a ref", async () => {
      const own = await addAttachment(wsA, { safetyStatus: "pending_scan" })
      const foreign = await addAttachment(wsB, { safetyStatus: "pending_scan" })
      const mislabelled = await addAttachment(wsA, { safetyStatus: "pending_scan" })
      const foreignBefore = await rowsOf("attachments", "id", foreign)
      const mislabelledBefore = await rowsOf("attachments", "id", mislabelled)

      const flipped = await AttachmentRepository.quarantineStuckPendingScans(pool, [
        { workspaceId: wsA, attachmentId: own },
        { workspaceId: wsA, attachmentId: foreign },
        { workspaceId: wsB, attachmentId: mislabelled },
      ])

      expect({
        flipped,
        own: (await rowsOf("attachments", "id", own)).map((row) => [row.safety_status, row.processing_status]),
        foreign: await rowsOf("attachments", "id", foreign),
        mislabelled: await rowsOf("attachments", "id", mislabelled),
      }).toEqual({
        flipped: [{ workspaceId: wsA, attachmentId: own }],
        own: [["quarantined", "skipped"]],
        foreign: foreignBefore,
        mislabelled: mislabelledBefore,
      })
    })

    test("should quarantine a stale workspace A pending_scan attachment when only a workspace B upload row names its id", async () => {
      const stale = await addAttachment(wsA, { safetyStatus: "pending_scan", createdAt: LONG_AGO })
      await addUpload(wsB, stale)

      const quarantined = await AttachmentRepository.quarantineStalePendingScans(pool, {
        olderThan: SWEEP_CUTOFF,
        limit: 100,
      })

      expect({
        quarantined: quarantined.filter((id) => id === stale),
        stale: (await rowsOf("attachments", "id", stale)).map((row) => [row.safety_status, row.processing_status]),
      }).toEqual({ quarantined: [stale], stale: [["quarantined", "skipped"]] })
    })
  })

  describe("AttachmentRepository searches", () => {
    test("should list only workspace A attachments and extractions when a stream is browsed without a content type filter", async () => {
      const needle = token()
      const own = await addAttachment(wsA, { streamId: streamA, filename: `${needle}-own.png` })
      const ownExtracted = await addAttachment(wsA, { streamId: streamA, filename: "plain-a.png" })
      const foreignExtracted = await addAttachment(wsA, { streamId: streamA, filename: "plain-b.png" })
      await addAttachment(wsB, { streamId: streamA, filename: `${needle}-leak.png` })
      await addExtraction(wsA, ownExtracted, { summary: `${needle} chart` })
      await addExtraction(wsB, foreignExtracted, { summary: `${needle} foreign chart` })

      const found = await AttachmentRepository.searchWithExtractions(pool, {
        workspaceId: wsA,
        streamIds: [streamA],
        query: needle,
      })

      expect(
        found
          .map((attachment) => ({ id: attachment.id, summary: attachment.extraction?.summary ?? null }))
          .sort((left, right) => left.id.localeCompare(right.id))
      ).toEqual(
        [
          { id: own, summary: null },
          { id: ownExtracted, summary: `${needle} chart` },
        ].sort((left, right) => left.id.localeCompare(right.id))
      )
    })

    test("should list only workspace A attachments when a stream is searched by extraction content type", async () => {
      const needle = token()
      const ownExtracted = await addAttachment(wsA, { streamId: streamA, filename: "typed-a.png" })
      const foreignExtracted = await addAttachment(wsA, { streamId: streamA, filename: "typed-b.png" })
      const leaked = await addAttachment(wsB, { streamId: streamA, filename: "typed-c.png" })
      await addExtraction(wsA, ownExtracted, { contentType: "chart", summary: `${needle} own` })
      await addExtraction(wsB, foreignExtracted, { contentType: "chart", summary: `${needle} foreign` })
      await addExtraction(wsA, leaked, { contentType: "chart", summary: `${needle} leaked` })

      const found = await AttachmentRepository.searchWithExtractions(pool, {
        workspaceId: wsA,
        streamIds: [streamA],
        query: needle,
        contentTypes: ["chart"],
      })

      expect(found.map((attachment) => ({ id: attachment.id, summary: attachment.extraction?.summary }))).toEqual([
        { id: ownExtracted, summary: `${needle} own` },
      ])
    })

    test("should return only workspace A facts when the explorer searches a stream", async () => {
      const needle = token()
      const own = await addAttachment(wsA, {
        streamId: streamA,
        messageId: messageId(),
        uploadedBy: userA.id,
        filename: `${needle}-own.png`,
        createdAt: at(1),
      })
      const foreignUploader = await addAttachment(wsA, {
        streamId: streamA,
        messageId: messageId(),
        uploadedBy: userB.id,
        filename: `${needle}-uploader.png`,
        createdAt: at(2),
      })
      const foreignExtracted = await addAttachment(wsA, {
        streamId: streamA,
        messageId: messageId(),
        uploadedBy: userA.id,
        filename: `${needle}-extracted.png`,
        createdAt: at(3),
      })
      const referenced = await addAttachment(wsA, {
        streamId: streamA,
        messageId: messageId(),
        uploadedBy: userA.id,
        filename: `${needle}-referenced.png`,
        createdAt: at(4),
      })
      await addAttachment(wsB, {
        streamId: streamA,
        messageId: messageId(),
        uploadedBy: userB.id,
        filename: `${needle}-leak.png`,
        createdAt: at(5),
      })
      await addExtraction(wsB, foreignExtracted, { contentType: "photo", summary: `${needle} foreign` })
      for (const [wid, count] of [
        [wsA, 1],
        [wsB, 2],
      ] as const) {
        for (let i = 0; i < count; i++) {
          await insertRow("attachment_references", {
            id: attachmentReferenceId(),
            workspace_id: wid,
            attachment_id: referenced,
            message_id: messageId(),
            stream_id: streamA,
          })
        }
      }

      const found = await AttachmentRepository.search(pool, {
        workspaceId: wsA,
        userId: userA.id,
        streamIds: [streamA],
        nameSubstring: needle,
        limit: 20,
      })

      expect(
        found.map((row) => ({
          id: row.id,
          workspaceId: row.workspaceId,
          extraction: row.extraction,
          uploaderSlug: row.uploaderSlug,
          uploaderName: row.uploaderName,
          streamType: row.streamType,
          referenceCount: row.referenceCount,
        }))
      ).toEqual([
        {
          id: own,
          workspaceId: wsA,
          extraction: null,
          uploaderSlug: userA.slug,
          uploaderName: userA.name,
          streamType: "channel",
          referenceCount: 0,
        },
        {
          id: foreignUploader,
          workspaceId: wsA,
          extraction: null,
          uploaderSlug: null,
          uploaderName: null,
          streamType: "channel",
          referenceCount: 0,
        },
        {
          id: foreignExtracted,
          workspaceId: wsA,
          extraction: null,
          uploaderSlug: userA.slug,
          uploaderName: userA.name,
          streamType: "channel",
          referenceCount: 0,
        },
        {
          id: referenced,
          workspaceId: wsA,
          extraction: null,
          uploaderSlug: userA.slug,
          uploaderName: userA.name,
          streamType: "channel",
          referenceCount: 1,
        },
      ])
    })
  })

  describe("AttachmentUploadRepository", () => {
    test("should not find a workspace B upload row when workspace A asks for its own attachment id", async () => {
      const own = await addAttachment(wsA)
      const other = await addAttachment(wsA)
      await addUpload(wsB, own)
      await addUpload(wsA, other)

      const byOne = await AttachmentUploadRepository.findByAttachmentId(pool, wsA, own)
      const byMany = await AttachmentUploadRepository.findByAttachmentIds(pool, wsA, [own, other])

      expect({ byOne, byMany: [...byMany.keys()] }).toEqual({ byOne: null, byMany: [other] })
    })

    test("should keep a workspace B upload row when workspace A deletes by its own attachment id", async () => {
      const single = await addAttachment(wsA)
      const batch = await addAttachment(wsA)
      const singleUpload = await addUpload(wsB, single)
      const batchUpload = await addUpload(wsB, batch)
      const before = [
        ...(await rowsOf("attachment_uploads", "id", singleUpload)),
        ...(await rowsOf("attachment_uploads", "id", batchUpload)),
      ]

      await AttachmentUploadRepository.deleteByAttachmentId(pool, wsA, single)
      await AttachmentUploadRepository.deleteByAttachmentIds(pool, wsA, [batch])

      expect([
        ...(await rowsOf("attachment_uploads", "id", singleUpload)),
        ...(await rowsOf("attachment_uploads", "id", batchUpload)),
      ]).toEqual(before)
    })

    test.each([
      [
        "markUploading",
        "uploading" as const,
        (db: Pool, ws: string, id: string) => AttachmentUploadRepository.markUploading(db, ws, id),
      ],
      [
        "markUploaded",
        "uploaded" as const,
        (db: Pool, ws: string, id: string) => AttachmentUploadRepository.markUploaded(db, ws, id),
      ],
      [
        "markFailed",
        "failed" as const,
        (db: Pool, ws: string, id: string) => AttachmentUploadRepository.markFailed(db, ws, id, { code: "scope" }),
      ],
    ])(
      "should not %s a workspace B upload row when workspace A asks for its own attachment id",
      async (_, status, mark) => {
        const own = await addAttachment(wsA)
        const other = await addAttachment(wsA)
        const foreignUpload = await addUpload(wsB, own)
        await addUpload(wsA, other)
        const before = await rowsOf("attachment_uploads", "id", foreignUpload)

        const marked = {
          foreign: await mark(pool, wsA, own),
          own: (await mark(pool, wsA, other))?.status,
        }

        expect({ marked, foreign: await rowsOf("attachment_uploads", "id", foreignUpload) }).toEqual({
          marked: { foreign: null, own: status },
          foreign: before,
        })
      }
    )

    test.each([
      [
        "failStale",
        "reserved" as const,
        "failed" as const,
        (olderThan: Date) => AttachmentUploadRepository.failStale(pool, { olderThan, limit: 100 }),
      ],
      [
        "abandonStaleFailed",
        "failed" as const,
        "abandoned" as const,
        (olderThan: Date) => AttachmentUploadRepository.abandonStaleFailed(pool, { olderThan, limit: 100 }),
      ],
      [
        "deleteStaleUploaded",
        "uploaded" as const,
        "uploaded" as const,
        (olderThan: Date) => AttachmentUploadRepository.deleteStaleUploaded(pool, { olderThan, limit: 100 }),
      ],
    ])(
      "should not report the bind state of a workspace B attachment when %s sweeps a workspace A upload row naming its id",
      async (_, seededStatus, sweptStatus, sweep) => {
        const foreignAttachment = await addAttachment(wsB, { streamId: streamId(), messageId: messageId() })
        await addUpload(wsA, foreignAttachment, { status: seededStatus, updatedAt: LONG_AGO })
        const foreignBefore = await rowsOf("attachments", "id", foreignAttachment)

        const swept = await sweep(SWEEP_CUTOFF)

        expect({
          swept: swept.filter((upload) => upload.attachmentId === foreignAttachment),
          foreignAttachment: await rowsOf("attachments", "id", foreignAttachment),
        }).toEqual({
          swept: [
            {
              attachmentId: foreignAttachment,
              workspaceId: wsA,
              status: sweptStatus,
              messageId: null,
              streamId: null,
              storagePath: null,
            },
          ],
          foreignAttachment: foreignBefore,
        })
      }
    )
  })

  describe("AttachmentExtractionRepository", () => {
    test("should not find a workspace B extraction when workspace A asks for its own attachment id", async () => {
      const own = await addAttachment(wsA)
      const other = await addAttachment(wsA)
      await addExtraction(wsB, own)
      const otherExtraction = await addExtraction(wsA, other)

      const byOne = await AttachmentExtractionRepository.findByAttachmentId(pool, wsA, own)
      const byMany = await AttachmentExtractionRepository.findByAttachmentIds(pool, wsA, [own, other])

      expect({ byOne, byMany: [...byMany.values()].map((extraction) => extraction.id) }).toEqual({
        byOne: null,
        byMany: [otherExtraction],
      })
    })

    test("should list only workspace A extractions when a workspace is browsed with or without a content type", async () => {
      const [wsX, wsY] = [await seedWorkspace("x"), await seedWorkspace("y")]
      const chartX = await addExtraction(wsX, attachmentId(), { contentType: "chart" })
      await addExtraction(wsY, attachmentId(), { contentType: "chart" })
      await addExtraction(wsY, attachmentId(), { contentType: "photo" })

      const byType = await AttachmentExtractionRepository.findByWorkspace(pool, wsX, { contentType: "chart" })
      const all = await AttachmentExtractionRepository.findByWorkspace(pool, wsX)

      expect({ byType: byType.map((row) => row.id), all: all.map((row) => row.id) }).toEqual({
        byType: [chartX],
        all: [chartX],
      })
    })

    test("should keep a workspace B extraction when workspace A deletes by its own attachment id", async () => {
      const own = await addAttachment(wsA)
      const other = await addAttachment(wsA)
      const foreign = await addExtraction(wsB, own)
      await addExtraction(wsA, other)
      const before = await rowsOf("attachment_extractions", "id", foreign)

      const deleted = {
        foreign: await AttachmentExtractionRepository.deleteByAttachmentId(pool, wsA, own),
        own: await AttachmentExtractionRepository.deleteByAttachmentId(pool, wsA, other),
      }

      expect({ deleted, foreign: await rowsOf("attachment_extractions", "id", foreign) }).toEqual({
        deleted: { foreign: false, own: true },
        foreign: before,
      })
    })

    test("should fill the missing search config of only workspace A extractions when a batch names a workspace B one", async () => {
      const own = await addExtraction(wsA, attachmentId())
      const foreign = await addExtraction(wsB, attachmentId())
      const before = await rowsOf("attachment_extractions", "id", foreign)

      const filled = await AttachmentExtractionRepository.fillMissingSearchConfigs(pool, wsA, [
        { id: own, searchConfig: "english" },
        { id: foreign, searchConfig: "english" },
      ])

      expect({
        filled,
        own: (await rowsOf("attachment_extractions", "id", own)).map((row) => row.search_config),
        foreign: await rowsOf("attachment_extractions", "id", foreign),
      }).toEqual({ filled: 1, own: ["english"], foreign: before })
    })

    test("should not store a summary embedding on a workspace B extraction when workspace A embeds its own attachment id", async () => {
      const own = await addAttachment(wsA)
      const other = await addAttachment(wsA)
      const foreign = await addExtraction(wsB, own)
      await addExtraction(wsA, other)
      const before = await rowsOf("attachment_extractions", "id", foreign)
      const embedding = Array.from({ length: 1536 }, () => 0.01)

      const embedded = {
        foreign: await AttachmentExtractionRepository.updateSummaryEmbedding(pool, wsA, own, embedding),
        own: await AttachmentExtractionRepository.updateSummaryEmbedding(pool, wsA, other, embedding),
      }

      expect({
        embedded,
        foreign: await rowsOf("attachment_extractions", "id", foreign),
        own: (await AttachmentExtractionRepository.findByAttachmentId(pool, wsA, other))?.hasSummaryEmbedding,
      }).toEqual({ embedded: { foreign: false, own: true }, foreign: before, own: true })
    })

    test("should not copy a workspace B extraction when workspace A copies from its own attachment id", async () => {
      const source = await addAttachment(wsA)
      const ownSource = await addAttachment(wsA)
      const foreignDestination = attachmentId()
      const ownDestination = attachmentId()
      await addExtraction(wsB, source)
      await addExtraction(wsA, ownSource)

      const copied = {
        foreign: await AttachmentExtractionRepository.copyForAttachment(pool, {
          id: extractionId(),
          sourceAttachmentId: source,
          attachmentId: foreignDestination,
          workspaceId: wsA,
        }),
        own: await AttachmentExtractionRepository.copyForAttachment(pool, {
          id: extractionId(),
          sourceAttachmentId: ownSource,
          attachmentId: ownDestination,
          workspaceId: wsA,
        }),
      }

      expect({
        copied,
        foreign: await rowsOf("attachment_extractions", "attachment_id", foreignDestination),
        own: (await rowsOf("attachment_extractions", "attachment_id", ownDestination)).map((row) => row.workspace_id),
      }).toEqual({ copied: { foreign: false, own: true }, foreign: [], own: [wsA] })
    })
  })

  describe("PdfProcessingJobRepository", () => {
    test("should not find a workspace B PDF job by id when asked from workspace A", async () => {
      const own = await addPdfJob(wsA)
      const foreign = await addPdfJob(wsB)

      expect(await PdfProcessingJobRepository.findById(pool, wsA, foreign)).toBeNull()
      expect((await PdfProcessingJobRepository.findById(pool, wsA, own))?.id).toBe(own)
    })

    test.each([
      ["unconditionally", undefined],
      ["guarded by one status", { onlyIfStatus: "preparing" as const }],
    ])("should not move a workspace B PDF job's status when asked %s from workspace A", async (_, options) => {
      const own = await addPdfJob(wsA)
      const foreign = await addPdfJob(wsB)
      const before = await rowsOf("pdf_processing_jobs", "id", foreign)

      const moved = {
        foreign: await PdfProcessingJobRepository.updateStatus(pool, wsA, foreign, "failed", options),
        own: await PdfProcessingJobRepository.updateStatus(pool, wsA, own, "failed", options),
      }

      expect({
        moved,
        own: (await rowsOf("pdf_processing_jobs", "id", own)).map((row) => row.status),
        foreign: await rowsOf("pdf_processing_jobs", "id", foreign),
      }).toEqual({ moved: { foreign: false, own: true }, own: ["failed"], foreign: before })
    })

    test("should not count a page on a workspace B PDF job when asked from workspace A", async () => {
      const own = await addPdfJob(wsA)
      const foreign = await addPdfJob(wsB)
      const before = await rowsOf("pdf_processing_jobs", "id", foreign)

      const counted = {
        completedForeign: await PdfProcessingJobRepository.incrementPagesCompleted(pool, wsA, foreign),
        failedForeign: await PdfProcessingJobRepository.incrementPagesFailed(pool, wsA, foreign),
        completedOwn: (await PdfProcessingJobRepository.incrementPagesCompleted(pool, wsA, own))?.pagesCompleted,
        failedOwn: (await PdfProcessingJobRepository.incrementPagesFailed(pool, wsA, own))?.pagesFailed,
      }

      expect({ counted, foreign: await rowsOf("pdf_processing_jobs", "id", foreign) }).toEqual({
        counted: { completedForeign: null, failedForeign: null, completedOwn: 1, failedOwn: 1 },
        foreign: before,
      })
    })

    test("should not report a workspace B PDF job as processed when asked from workspace A", async () => {
      const foreign = await addPdfJob(wsB, { totalPages: 1, pagesCompleted: 1 })

      expect({
        fromA: await PdfProcessingJobRepository.isAllPagesProcessed(pool, wsA, foreign),
        fromB: await PdfProcessingJobRepository.isAllPagesProcessed(pool, wsB, foreign),
      }).toEqual({ fromA: false, fromB: true })
    })
  })

  describe("PdfPageExtractionRepository", () => {
    test("should list only workspace A pages when a workspace B page shares the attachment id", async () => {
      const attachment = await addAttachment(wsA)
      const pageOne = await addPdfPage(wsA, attachment, 1)
      await addPdfPage(wsB, attachment, 2)

      const all = await PdfPageExtractionRepository.findByAttachmentId(pool, wsA, attachment)
      const range = await PdfPageExtractionRepository.findByAttachmentAndPageRange(pool, wsA, attachment, 1, 3)

      expect({ all: all.map((page) => page.id), range: range.map((page) => page.id) }).toEqual({
        all: [pageOne],
        range: [pageOne],
      })
    })

    test("should not find a workspace B page when workspace A asks for its own attachment and page number", async () => {
      const attachment = await addAttachment(wsA)
      const own = await addPdfPage(wsA, attachment, 1)
      await addPdfPage(wsB, attachment, 2)

      expect({
        foreign: await PdfPageExtractionRepository.findByAttachmentAndPage(pool, wsA, attachment, 2),
        own: (await PdfPageExtractionRepository.findByAttachmentAndPage(pool, wsA, attachment, 1))?.id,
      }).toEqual({ foreign: null, own })
    })

    test("should not update a workspace B page when asked from workspace A", async () => {
      const attachment = await addAttachment(wsA)
      const own = await addPdfPage(wsA, attachment, 1)
      const foreign = await addPdfPage(wsB, attachment, 2)
      const before = await rowsOf("pdf_page_extractions", "id", foreign)

      const updated = {
        foreign: await PdfPageExtractionRepository.update(pool, wsA, foreign, { rawText: "overwritten" }),
        own: (await PdfPageExtractionRepository.update(pool, wsA, own, { rawText: "mine" }))?.rawText,
      }

      expect({ updated, foreign: await rowsOf("pdf_page_extractions", "id", foreign) }).toEqual({
        updated: { foreign: null, own: "mine" },
        foreign: before,
      })
    })

    test.each([
      ["unconditionally", undefined],
      ["guarded by a status list", { onlyIfStatusIn: ["pending" as const] }],
    ])("should not move a workspace B page's status when asked %s from workspace A", async (_, options) => {
      const attachment = await addAttachment(wsA)
      const own = await addPdfPage(wsA, attachment, 1)
      const foreign = await addPdfPage(wsB, attachment, 2)
      const before = await rowsOf("pdf_page_extractions", "id", foreign)

      const moved = {
        foreign: await PdfPageExtractionRepository.updateProcessingStatus(pool, wsA, foreign, "failed", options),
        own: await PdfPageExtractionRepository.updateProcessingStatus(pool, wsA, own, "failed", options),
      }

      expect({
        moved,
        own: (await rowsOf("pdf_page_extractions", "id", own)).map((row) => row.processing_status),
        foreign: await rowsOf("pdf_page_extractions", "id", foreign),
      }).toEqual({ moved: { foreign: false, own: true }, own: ["failed"], foreign: before })
    })
  })

  describe("VideoTranscodeJobRepository", () => {
    test("should not find a workspace B transcode job when workspace A asks for its own attachment id", async () => {
      const own = await addAttachment(wsA)
      const other = await addAttachment(wsA)
      await addVideoJob(wsB, own)
      const otherJob = await addVideoJob(wsA, other)

      expect({
        foreign: await VideoTranscodeJobRepository.findByAttachmentId(pool, wsA, own),
        own: (await VideoTranscodeJobRepository.findByAttachmentId(pool, wsA, other))?.id,
      }).toEqual({ foreign: null, own: otherJob })
    })

    test.each([
      [
        "updateSubmitted",
        "submitted",
        (ws: string, id: string) => VideoTranscodeJobRepository.updateSubmitted(pool, ws, id, "mc_1"),
      ],
      [
        "updateCompleted",
        "completed",
        (ws: string, id: string) =>
          VideoTranscodeJobRepository.updateCompleted(pool, ws, id, "scope/out.mp4", "scope/t.jpg"),
      ],
      [
        "updateFailed",
        "failed",
        (ws: string, id: string) => VideoTranscodeJobRepository.updateFailed(pool, ws, id, "boom"),
      ],
    ])("should not %s on a workspace B transcode job when asked from workspace A", async (_, status, update) => {
      const own = await addVideoJob(wsA)
      const foreign = await addVideoJob(wsB)
      const before = await rowsOf("video_transcode_jobs", "id", foreign)

      const updated = { foreign: await update(wsA, foreign), own: await update(wsA, own) }

      expect({
        updated,
        own: (await rowsOf("video_transcode_jobs", "id", own)).map((row) => row.status),
        foreign: await rowsOf("video_transcode_jobs", "id", foreign),
      }).toEqual({ updated: { foreign: false, own: true }, own: [status], foreign: before })
    })
  })

  describe("AvatarUploadRepository", () => {
    test("should not find a workspace B avatar upload by id when asked from workspace A", async () => {
      const own = await addAvatarUpload(wsA, userA.id)
      const foreign = await addAvatarUpload(wsB, userB.id)

      expect({
        foreign: await AvatarUploadRepository.findById(pool, wsA, foreign),
        own: (await AvatarUploadRepository.findById(pool, wsA, own))?.id,
      }).toEqual({ foreign: null, own })
    })

    test("should keep a workspace B avatar upload when workspace A deletes by its id", async () => {
      const own = await addAvatarUpload(wsA, userA.id)
      const foreign = await addAvatarUpload(wsB, userB.id)
      const before = await rowsOf("avatar_uploads", "id", foreign)

      await AvatarUploadRepository.deleteById(pool, wsA, foreign)
      await AvatarUploadRepository.deleteById(pool, wsA, own)

      expect({
        own: await rowsOf("avatar_uploads", "id", own),
        foreign: await rowsOf("avatar_uploads", "id", foreign),
      }).toEqual({ own: [], foreign: before })
    })

    test("should keep a workspace B avatar upload that points at a workspace A user when workspace A deletes that user's uploads", async () => {
      const own = await addAvatarUpload(wsA, userA.id)
      const foreign = await addAvatarUpload(wsB, userA.id)
      const before = await rowsOf("avatar_uploads", "id", foreign)

      await AvatarUploadRepository.deleteByUserId(pool, wsA, userA.id)

      expect({
        own: await rowsOf("avatar_uploads", "id", own),
        foreign: await rowsOf("avatar_uploads", "id", foreign),
      }).toEqual({ own: [], foreign: before })
    })
  })
})
