import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AttachmentReferenceRepository, AttachmentRepository, AttachmentService } from "../../src/features/attachments"
import { attachmentId, attachmentReferenceId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

describe("AttachmentService.getAccessibleVia", () => {
  let pool: Pool
  let service: AttachmentService
  const ws = workspaceId()
  const origin = streamId()
  const reference = streamId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new AttachmentService(pool, {} as never, {} as never)
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedResentAttachment(): Promise<string> {
    const id = attachmentId()
    await AttachmentRepository.insert(pool, {
      id,
      workspaceId: ws,
      streamId: origin,
      uploadedBy: userId(),
      filename: "plan.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      storagePath: `${ws}/${id}/plan.txt`,
      safetyStatus: "clean",
    })
    await AttachmentReferenceRepository.insertMany(pool, [
      { id: attachmentReferenceId(), workspaceId: ws, attachmentId: id, messageId: messageId(), streamId: reference },
    ])
    return id
  }

  test("should grant access through the readable stream that references the attachment, or through its origin when that is readable", async () => {
    const id = await seedResentAttachment()
    const via = async (accessibleStreamIds: string[]) =>
      (await service.getAccessibleVia(id, { workspaceId: ws, accessibleStreamIds }))?.viaStreamIds ?? null

    const [originUnreadable, originReadable, neither] = await Promise.all([
      via([reference]),
      via([origin, reference]),
      via([streamId()]),
    ])

    expect({ originUnreadable, originReadable, neither }).toEqual({
      originUnreadable: [reference],
      originReadable: [origin],
      neither: null,
    })
  })
})
