/**
 * Stale reserved-upload sweep integration tests.
 *
 * The sweep is the safety net for uploads whose client died without reporting
 * failure: idle reserved/uploading rows flip to `failed` (so viewers stop
 * seeing a dead "Uploading…" chip), long-failed rows flip to `abandoned`
 * (bound ones stay as tombstones; never-bound zombies are deleted along with
 * their S3 objects), and orphaned scan-window rows are dropped.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import { Pool } from "pg"
import { withTransaction, addTestMember, setupTestDatabase } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { AttachmentRepository, AttachmentUploadRepository, AttachmentService } from "../../src/features/attachments"
import { sql } from "../../src/db"
import { userId, workspaceId, streamId, attachmentId, messageId } from "../../src/lib/id"
import { AttachmentSafetyStatuses, AttachmentUploadStatuses } from "@threa/types"

const HOUR_MS = 60 * 60 * 1000

describe("Attachment upload sweep", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Sweep Test Workspace",
        slug: `sweep-ws-${testWorkspaceId}`,
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
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  function createService(storageDelete = mock(async () => {})) {
    const storage = { delete: storageDelete } as any
    const malwareScanner = { scan: mock(async () => ({ status: AttachmentSafetyStatuses.CLEAN })) } as any
    return { service: new AttachmentService(pool, storage, malwareScanner), storageDelete }
  }

  async function reserveVia(service: AttachmentService, opts?: { bindToMessage?: boolean }) {
    const id = attachmentId()
    await service.reserve({
      id,
      workspaceId: testWorkspaceId,
      uploadedBy: testUserId,
      filename: "stale.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 10,
      e2e: false,
    })
    if (opts?.bindToMessage) {
      const msgId = messageId()
      await pool.query(sql`
        UPDATE attachments SET message_id = ${msgId}, stream_id = ${testStreamId} WHERE id = ${id}
      `)
    }
    return id
  }

  async function ageUploadRow(id: string, ageMs: number, status?: string) {
    if (status) {
      await pool.query(sql`
        UPDATE attachment_uploads
        SET updated_at = NOW() - make_interval(secs => ${ageMs / 1000}), status = ${status}
        WHERE attachment_id = ${id}
      `)
    } else {
      await pool.query(sql`
        UPDATE attachment_uploads
        SET updated_at = NOW() - make_interval(secs => ${ageMs / 1000})
        WHERE attachment_id = ${id}
      `)
    }
  }

  test("idle reserved rows flip to failed; bound ones emit a status event", async () => {
    const { service } = createService()
    const boundId = await reserveVia(service, { bindToMessage: true })
    const unboundId = await reserveVia(service)
    const freshId = await reserveVia(service)
    await ageUploadRow(boundId, 5 * HOUR_MS)
    await ageUploadRow(unboundId, 5 * HOUR_MS)

    await service.sweepStaleUploads()

    const bound = await AttachmentUploadRepository.findByAttachmentId(pool, testWorkspaceId, boundId)
    const unbound = await AttachmentUploadRepository.findByAttachmentId(pool, testWorkspaceId, unboundId)
    const fresh = await AttachmentUploadRepository.findByAttachmentId(pool, testWorkspaceId, freshId)
    expect(bound?.status).toBe(AttachmentUploadStatuses.FAILED)
    expect(bound?.errorCode).toBe("stale")
    expect(unbound?.status).toBe(AttachmentUploadStatuses.FAILED)
    expect(fresh?.status).toBe(AttachmentUploadStatuses.RESERVED)

    // Only the bound attachment produced a viewer-facing event.
    const events = await pool.query(sql`
      SELECT payload FROM outbox
      WHERE event_type = 'attachment:upload_status_changed'
        AND payload->>'attachmentId' = ANY(${[boundId, unboundId]})
    `)
    expect(events.rows.map((r) => r.payload.attachmentId)).toEqual([boundId])
    expect(events.rows[0].payload).toMatchObject({
      uploadStatus: "failed",
      safetyStatus: "pending_upload",
      streamId: testStreamId,
    })
  })

  test("long-failed rows are abandoned: never-bound zombies deleted with their bytes, bound ones kept as tombstones", async () => {
    const { service, storageDelete } = createService()
    const boundId = await reserveVia(service, { bindToMessage: true })
    const unboundId = await reserveVia(service)
    await ageUploadRow(boundId, 8 * 24 * HOUR_MS, AttachmentUploadStatuses.FAILED)
    await ageUploadRow(unboundId, 8 * 24 * HOUR_MS, AttachmentUploadStatuses.FAILED)

    const result = await service.sweepStaleUploads()
    expect(result.abandoned).toBe(2)

    // Bound: tombstone stays so the message renders "upload failed" forever.
    const bound = await AttachmentUploadRepository.findByAttachmentId(pool, testWorkspaceId, boundId)
    expect(bound?.status).toBe(AttachmentUploadStatuses.ABANDONED)
    expect(await AttachmentRepository.findById(pool, boundId)).not.toBeNull()

    // Unbound: attachment row, tracking row, and S3 object are all gone.
    expect(await AttachmentUploadRepository.findByAttachmentId(pool, testWorkspaceId, unboundId)).toBeNull()
    expect(await AttachmentRepository.findById(pool, unboundId)).toBeNull()
    const deletedPaths = storageDelete.mock.calls.map((c: unknown[]) => c[0])
    expect(deletedPaths).toEqual([`${testWorkspaceId}/${unboundId}/stale.bin`])
  })

  test("orphaned scan-window rows (stuck at uploaded) are dropped", async () => {
    const { service } = createService()
    const id = await reserveVia(service)
    await ageUploadRow(id, 5 * HOUR_MS, AttachmentUploadStatuses.UPLOADED)

    await service.sweepStaleUploads()

    expect(await AttachmentUploadRepository.findByAttachmentId(pool, testWorkspaceId, id)).toBeNull()
  })
})
