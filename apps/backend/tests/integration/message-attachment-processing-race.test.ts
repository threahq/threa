import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AttachmentSafetyStatuses, AuthorTypes, ProcessingStatuses } from "@threahq/types"
import { addTestMember, setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { AttachmentRepository } from "../../src/features/attachments"
import { EventService } from "../../src/features/messaging"
import { StreamEventRepository, StreamRepository } from "../../src/features/streams"
import { attachmentId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("Sending a message while its attachment finishes processing", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let eventService: EventService

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("message_attachment_race")
    pool = isolated.pool
    cleanup = isolated.cleanup
    eventService = new EventService(pool)
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function waitForBlockedSend(): Promise<void> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE attachments%'`
      )
      if (rows.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("the send never reached the attachment row lock")
  }

  test("should carry the finished status when the processing job commits during the send", async () => {
    const wsId = workspaceId()
    await WorkspaceRepository.insert(pool, { id: wsId, name: "Race", slug: `race-${wsId}`, createdBy: userId() })
    const author = await addTestMember(pool, wsId, `author-${wsId}`, "admin")
    const channel = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: wsId,
      type: "channel",
      slug: `race-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Race",
      visibility: "public",
      createdBy: author.id,
    })
    const id = attachmentId()
    await AttachmentRepository.insert(pool, {
      id,
      workspaceId: wsId,
      uploadedBy: author.id,
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 2048,
      storagePath: `${wsId}/${id}/clip.mp4`,
      safetyStatus: AttachmentSafetyStatuses.CLEAN,
    })

    const job = await pool.connect()
    let boundDuringJob: string | null | undefined
    try {
      await job.query("BEGIN")
      await AttachmentRepository.updateProcessingStatus(job, wsId, id, ProcessingStatuses.SKIPPED)
      const sending = eventService.createMessage({
        workspaceId: wsId,
        streamId: channel.id,
        authorId: author.id,
        authorType: AuthorTypes.USER,
        ...testMessageContent("here is the clip"),
        attachmentIds: [id],
      })
      await waitForBlockedSend()
      boundDuringJob = (await AttachmentRepository.findById(job, wsId, id))?.messageId
      await job.query("COMMIT")
      await sending
    } catch (error) {
      await job.query("ROLLBACK").catch(() => {})
      throw error
    } finally {
      job.release()
    }

    const events = await StreamEventRepository.list(pool, wsId, channel.id, { types: ["message_created"] })
    const attachments = (events[0]?.payload as { attachments?: unknown[] }).attachments
    expect({ boundDuringJob, attachments }).toEqual({
      boundDuringJob: null,
      attachments: [
        {
          id,
          filename: "clip.mp4",
          mimeType: "video/mp4",
          sizeBytes: 2048,
          processingStatus: ProcessingStatuses.SKIPPED,
        },
      ],
    })
  })
})
