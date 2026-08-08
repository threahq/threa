/**
 * E2E tests for file attachments.
 *
 * Tests the full flow: upload to MinIO, store metadata, attach to messages.
 * Requires MinIO to be running (started by dev script or docker-compose).
 *
 * Run with: bun test --preload ./tests/setup.ts tests/e2e/attachments.test.ts
 */

import { describe, test, expect } from "bun:test"
import {
  TestClient,
  loginAs,
  createWorkspace,
  createScratchpad,
  createChannel,
  uploadAttachment,
  getAttachmentDownloadUrl,
  deleteAttachment,
  sendMessageWithAttachments,
  sendMessage,
  joinWorkspace,
  addStreamMember,
  reserveAttachment,
  uploadReservedContent,
  reportAttachmentUploadFailure,
  getBootstrap,
} from "../client"

const testRunId = Math.random().toString(36).substring(7)
const testEmail = (name: string) => `${name}-${testRunId}@test.com`

describe("File Attachments E2E", () => {
  describe("Upload", () => {
    test("should upload a text file and store metadata", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("upload-text"), "Upload Text Test")
      const workspace = await createWorkspace(client, `Upload WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      const attachment = await uploadAttachment(client, workspace.id, {
        content: "Hello, world! This is a test file.",
        filename: "hello.txt",
        mimeType: "text/plain",
      })

      expect(attachment).toMatchObject({
        workspaceId: workspace.id,
        streamId: null,
        filename: "hello.txt",
        mimeType: "text/plain",
        messageId: null,
        storageProvider: "s3",
        processingStatus: "pending",
      })
      expect(attachment.id).toMatch(/^attach_/)
      expect(attachment.sizeBytes).toBeGreaterThan(0)
    })

    test("should upload an image file", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("upload-image"), "Upload Image Test")
      const workspace = await createWorkspace(client, `Upload Img WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      // Create a minimal PNG (1x1 transparent pixel)
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
        0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])

      const attachment = await uploadAttachment(client, workspace.id, {
        content: pngData,
        filename: "pixel.png",
        mimeType: "image/png",
      })

      expect(attachment.filename).toBe("pixel.png")
      expect(attachment.mimeType).toBe("image/png")
      expect(attachment.sizeBytes).toBe(pngData.length)
    })

    test("should require workspace usership", async () => {
      const client1 = new TestClient()
      const client2 = new TestClient()

      await loginAs(client1, testEmail("upload-member-1"), "Upload Member 1")
      await loginAs(client2, testEmail("upload-member-2"), "Upload Member 2")

      const workspace = await createWorkspace(client1, `Upload Member WS ${testRunId}`)

      // client2 is not a member of the workspace
      const { status, data } = await client2.uploadFile<{ error: string }>(
        `/api/workspaces/${workspace.id}/attachments`,
        {
          content: "Should not upload",
          filename: "forbidden.txt",
          mimeType: "text/plain",
        }
      )

      expect(status).toBe(403)
      expect(data.error).toContain("Not a user in this workspace")
    })
  })

  describe("Download URL", () => {
    test("should generate presigned download URL", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("download-url"), "Download URL Test")
      const workspace = await createWorkspace(client, `Download WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      const attachment = await uploadAttachment(client, workspace.id, {
        content: "Content to download",
        filename: "download-me.txt",
        mimeType: "text/plain",
      })

      const url = await getAttachmentDownloadUrl(client, workspace.id, attachment.id)

      expect(url).toMatch(/^http/)
      expect(url).toContain(attachment.id)
      // URL should be a presigned S3/MinIO URL
      expect(url).toMatch(/X-Amz-Signature|signature/)
    })

    test("should actually be downloadable from MinIO", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("download-real"), "Download Real Test")
      const workspace = await createWorkspace(client, `Download Real WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      const content = `Test content ${testRunId}`
      const attachment = await uploadAttachment(client, workspace.id, {
        content,
        filename: "real-download.txt",
        mimeType: "text/plain",
      })

      const url = await getAttachmentDownloadUrl(client, workspace.id, attachment.id)

      // Actually fetch from MinIO
      const response = await fetch(url)
      expect(response.ok).toBe(true)

      const downloaded = await response.text()
      expect(downloaded).toBe(content)
    })
  })

  describe("Attach to Message", () => {
    test("should attach file to message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("attach-msg"), "Attach Message Test")
      const workspace = await createWorkspace(client, `Attach WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      // Upload first
      const attachment = await uploadAttachment(client, workspace.id, {
        content: "File attached to message",
        filename: "attached.txt",
        mimeType: "text/plain",
      })

      expect(attachment.messageId).toBeNull()

      // Send message with attachment
      const message = await sendMessageWithAttachments(client, workspace.id, stream.id, "Here is the file", [
        attachment.id,
      ])

      expect(message.id).toMatch(/^msg_/)
      expect(message.contentMarkdown).toBe("Here is the file")
    })

    test("should attach multiple files to message", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("attach-multi"), "Attach Multi Test")
      const workspace = await createWorkspace(client, `Attach Multi WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      const attach1 = await uploadAttachment(client, workspace.id, {
        content: "File 1",
        filename: "file1.txt",
        mimeType: "text/plain",
      })

      const attach2 = await uploadAttachment(client, workspace.id, {
        content: "File 2",
        filename: "file2.txt",
        mimeType: "text/plain",
      })

      const message = await sendMessageWithAttachments(client, workspace.id, stream.id, "Multiple files attached", [
        attach1.id,
        attach2.id,
      ])

      expect(message.id).toMatch(/^msg_/)
    })

    test("should send message without attachments", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("no-attach"), "No Attach Test")
      const workspace = await createWorkspace(client, `No Attach WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      // Regular message without attachments still works
      const message = await sendMessage(client, workspace.id, stream.id, "No files here")

      expect(message.id).toMatch(/^msg_/)
      expect(message.contentMarkdown).toBe("No files here")
    })
  })

  describe("Delete", () => {
    test("should delete unattached file", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("delete-unattached"), "Delete Unattached Test")
      const workspace = await createWorkspace(client, `Delete WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      const attachment = await uploadAttachment(client, workspace.id, {
        content: "To be deleted",
        filename: "delete-me.txt",
        mimeType: "text/plain",
      })

      await deleteAttachment(client, workspace.id, attachment.id)

      // Should no longer be accessible
      const { status } = await client.get(`/api/workspaces/${workspace.id}/attachments/${attachment.id}/url`)
      expect(status).toBe(404)
    })

    test("should not delete attached file", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("delete-attached"), "Delete Attached Test")
      const workspace = await createWorkspace(client, `Delete Attached WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      const attachment = await uploadAttachment(client, workspace.id, {
        content: "Attached, cannot delete",
        filename: "keep-me.txt",
        mimeType: "text/plain",
      })

      // Attach to message
      await sendMessageWithAttachments(client, workspace.id, stream.id, "Keeping this file", [attachment.id])

      // Try to delete
      const { status, data } = await client.delete<{ error: string }>(
        `/api/workspaces/${workspace.id}/attachments/${attachment.id}`
      )

      expect(status).toBe(403)
      expect(data.error).toContain("Cannot delete attached")
    })
  })

  describe("Full Flow", () => {
    test("should complete upload-attach-download journey", async () => {
      const client = new TestClient()
      await loginAs(client, testEmail("full-flow"), "Full Flow Test")
      const workspace = await createWorkspace(client, `Full Flow WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)

      // 1. Upload file
      const content = `Full flow test content ${testRunId}`
      const attachment = await uploadAttachment(client, workspace.id, {
        content,
        filename: "full-flow.txt",
        mimeType: "text/plain",
      })

      expect(attachment.id).toMatch(/^attach_/)
      expect(attachment.streamId).toBeNull()
      expect(attachment.messageId).toBeNull()

      // 2. Attach to message
      const message = await sendMessageWithAttachments(client, workspace.id, stream.id, "Check out this file!", [
        attachment.id,
      ])

      expect(message.id).toMatch(/^msg_/)

      // 3. Get download URL and verify content
      const url = await getAttachmentDownloadUrl(client, workspace.id, attachment.id)
      const response = await fetch(url)
      const downloaded = await response.text()

      expect(downloaded).toBe(content)
    })
  })

  describe("Workspace-Scoped Upload", () => {
    /**
     * Attachments are uploaded to workspace-level, not to specific streams.
     * The stream is assigned when the attachment is linked to a message.
     *
     * This enables:
     * 1. Uploads in draft mode (before stream exists)
     * 2. Unified upload flow for all stream types
     * 3. Simpler authorization model (workspace usership for upload)
     */
    test("workspace user can upload file without specifying stream", async () => {
      // Setup: Create workspace and channel with owner
      const ownerClient = new TestClient()
      await loginAs(ownerClient, testEmail("tl-owner"), "TL Owner")
      const workspace = await createWorkspace(ownerClient, `TopLevel WS ${testRunId}`)
      const channel = await createChannel(ownerClient, workspace.id, `tl-channel-${testRunId}`, "private")

      // Owner sends a message (future thread root)
      await sendMessage(ownerClient, workspace.id, channel.id, "Discussion starter")

      // Add two more users to workspace and channel
      const member1Client = new TestClient()
      const member2Client = new TestClient()
      await loginAs(member1Client, testEmail("tl-member1"), "TL Member 1")
      await loginAs(member2Client, testEmail("tl-member2"), "TL Member 2")

      const member1 = await joinWorkspace(member1Client, workspace.id)
      const member2 = await joinWorkspace(member2Client, workspace.id)
      expect((await addStreamMember(ownerClient, workspace.id, channel.id, member1.id)).status).toBe(201)
      expect((await addStreamMember(ownerClient, workspace.id, channel.id, member2.id)).status).toBe(201)

      // Member1 uploads file to workspace (no stream specified)
      const attachment = await uploadAttachment(member1Client, workspace.id, {
        content: "File from member1",
        filename: "member1-file.txt",
        mimeType: "text/plain",
      })

      expect(attachment).toMatchObject({
        workspaceId: workspace.id,
        streamId: null,
        filename: "member1-file.txt",
      })

      // Member1 can attach the file to a message in the channel
      const message = await sendMessageWithAttachments(member1Client, workspace.id, channel.id, "Here is my file", [
        attachment.id,
      ])

      expect(message.id).toMatch(/^msg_/)
    })

    test("member2 can access file uploaded by member1 after it is attached to shared channel", async () => {
      // Setup: Create workspace and channel
      const ownerClient = new TestClient()
      await loginAs(ownerClient, testEmail("share-owner"), "Share Owner")
      const workspace = await createWorkspace(ownerClient, `Share WS ${testRunId}`)
      const channel = await createChannel(ownerClient, workspace.id, `share-channel-${testRunId}`, "private")

      // Add member1 and member2
      const member1Client = new TestClient()
      const member2Client = new TestClient()
      await loginAs(member1Client, testEmail("share-member1"), "Share Member 1")
      await loginAs(member2Client, testEmail("share-member2"), "Share Member 2")

      const member1 = await joinWorkspace(member1Client, workspace.id)
      const member2 = await joinWorkspace(member2Client, workspace.id)
      expect((await addStreamMember(ownerClient, workspace.id, channel.id, member1.id)).status).toBe(201)
      expect((await addStreamMember(ownerClient, workspace.id, channel.id, member2.id)).status).toBe(201)

      // Member1 uploads to workspace and attaches to channel message
      const content = `Shared content ${testRunId}`
      const attachment = await uploadAttachment(member1Client, workspace.id, {
        content,
        filename: "shared-file.txt",
        mimeType: "text/plain",
      })
      await sendMessageWithAttachments(member1Client, workspace.id, channel.id, "Sharing this", [attachment.id])

      // Member2 can get download URL and access the file (now attached to channel they're a member of)
      const url = await getAttachmentDownloadUrl(member2Client, workspace.id, attachment.id)
      const response = await fetch(url)
      expect(response.ok).toBe(true)

      const downloaded = await response.text()
      expect(downloaded).toBe(content)
    })
  })

  describe("Reserved Background Uploads", () => {
    const fileContent = `reserved bytes ${testRunId}`
    const reservedFile = { content: fileContent, filename: "reserved.txt", mimeType: "text/plain" }
    const reserveInput = {
      filename: reservedFile.filename,
      mimeType: reservedFile.mimeType,
      sizeBytes: Buffer.byteLength(fileContent),
    }

    async function setup(name: string) {
      const client = new TestClient()
      await loginAs(client, testEmail(name), `${name} Test`)
      const workspace = await createWorkspace(client, `${name} WS ${testRunId}`)
      const stream = await createScratchpad(client, workspace.id)
      return { client, workspace, stream }
    }

    test("reserves an id before bytes exist; downloads stay blocked until the upload settles", async () => {
      const { client, workspace } = await setup("reserve-basic")

      const { attachment, upload } = await reserveAttachment(client, workspace.id, reserveInput)
      expect(attachment.id).toMatch(/^attach_/)
      expect(attachment).toMatchObject({
        workspaceId: workspace.id,
        filename: "reserved.txt",
        safetyStatus: "pending_upload",
        messageId: null,
      })
      expect(upload.url).toContain(`/attachments/${attachment.id}/content`)

      // No bytes yet — the sharing gate must reject the download.
      const blocked = await client.get(`/api/workspaces/${workspace.id}/attachments/${attachment.id}/url`)
      expect(blocked.status).toBe(403)

      const { status } = await uploadReservedContent(client, workspace.id, attachment.id, reservedFile)
      expect(status).toBe(201)

      const url = await getAttachmentDownloadUrl(client, workspace.id, attachment.id)
      const response = await fetch(url)
      expect(await response.text()).toBe(fileContent)
    })

    test("send-while-uploading: a message binds the pending id, and the settle heals the summary", async () => {
      const { client, workspace, stream } = await setup("reserve-send")

      const { attachment } = await reserveAttachment(client, workspace.id, reserveInput)

      // Send BEFORE the bytes exist — the whole point of the reservation.
      const message = await sendMessageWithAttachments(client, workspace.id, stream.id, "file incoming", [
        attachment.id,
      ])
      expect(message.id).toMatch(/^msg_/)

      // The event payload carries the pending state for viewers.
      const preSettle = await getBootstrap(client, workspace.id, stream.id)
      const pendingEvent = preSettle.events.find(
        (e: any) => e.eventType === "message_created" && (e.payload as any).messageId === message.id
      ) as any
      expect(pendingEvent.payload.attachments).toEqual([
        expect.objectContaining({
          id: attachment.id,
          safetyStatus: "pending_upload",
          uploadStatus: "reserved",
        }),
      ])

      const { status } = await uploadReservedContent(client, workspace.id, attachment.id, reservedFile)
      expect(status).toBe(201)

      // Bootstrap enrichment overlays the settled state — the pending markers
      // are gone without any socket event having been observed.
      const postSettle = await getBootstrap(client, workspace.id, stream.id)
      const settledEvent = postSettle.events.find(
        (e: any) => e.eventType === "message_created" && (e.payload as any).messageId === message.id
      ) as any
      const settledSummary = settledEvent.payload.attachments[0]
      expect(settledSummary.id).toBe(attachment.id)
      expect(settledSummary.safetyStatus).toBeUndefined()
      expect(settledSummary.uploadStatus).toBeUndefined()

      const url = await getAttachmentDownloadUrl(client, workspace.id, attachment.id)
      const response = await fetch(url)
      expect(await response.text()).toBe(fileContent)
    })

    test("rejects another user's pending reservation at send", async () => {
      const { client, workspace, stream } = await setup("reserve-foreign")
      const other = new TestClient()
      await loginAs(other, testEmail("reserve-foreign-other"), "Other Uploader")
      await joinWorkspace(other, workspace.id)

      const { attachment } = await reserveAttachment(other, workspace.id, reserveInput)

      const { status } = await client.post(`/api/workspaces/${workspace.id}/messages`, {
        streamId: stream.id,
        content: "stealing your pending upload",
        attachmentIds: [attachment.id],
      })
      expect(status).toBeGreaterThanOrEqual(400)
    })

    test("rejects bytes from a non-owner before they reach storage", async () => {
      const { client, workspace } = await setup("reserve-hostile")
      const other = new TestClient()
      await loginAs(other, testEmail("reserve-hostile-other"), "Hostile Uploader")
      await joinWorkspace(other, workspace.id)

      const { attachment } = await reserveAttachment(client, workspace.id, reserveInput)

      const { status } = await uploadReservedContent(other, workspace.id, attachment.id, reservedFile)
      expect(status).toBe(403)
    })

    test("rejects a re-upload after the reservation settled", async () => {
      const { client, workspace } = await setup("reserve-resettle")

      const { attachment } = await reserveAttachment(client, workspace.id, reserveInput)
      const first = await uploadReservedContent(client, workspace.id, attachment.id, reservedFile)
      expect(first.status).toBe(201)

      // Settled: the tracking row is gone, so a byte-swap attempt 404s.
      const second = await uploadReservedContent(client, workspace.id, attachment.id, reservedFile)
      expect(second.status).toBe(404)
    })

    test("size mismatch marks the upload failed, and a correct retry recovers it", async () => {
      const { client, workspace } = await setup("reserve-size")

      const { attachment } = await reserveAttachment(client, workspace.id, reserveInput)

      const truncated = await uploadReservedContent(client, workspace.id, attachment.id, {
        ...reservedFile,
        content: fileContent.slice(0, 5),
      })
      expect(truncated.status).toBe(400)

      // Retry from `failed` with the full bytes succeeds.
      const retry = await uploadReservedContent(client, workspace.id, attachment.id, reservedFile)
      expect(retry.status).toBe(201)

      const url = await getAttachmentDownloadUrl(client, workspace.id, attachment.id)
      const response = await fetch(url)
      expect(await response.text()).toBe(fileContent)
    })

    test("failure report flips the upload to failed and a retry still works", async () => {
      const { client, workspace, stream } = await setup("reserve-fail-report")

      const { attachment } = await reserveAttachment(client, workspace.id, reserveInput)
      const message = await sendMessageWithAttachments(client, workspace.id, stream.id, "will fail first", [
        attachment.id,
      ])

      const reportStatus = await reportAttachmentUploadFailure(client, workspace.id, attachment.id, "network died")
      expect(reportStatus).toBe(204)

      // Viewers see the failure on a fresh bootstrap.
      const failedBootstrap = await getBootstrap(client, workspace.id, stream.id)
      const failedEvent = failedBootstrap.events.find(
        (e: any) => e.eventType === "message_created" && (e.payload as any).messageId === message.id
      ) as any
      expect(failedEvent.payload.attachments[0]).toMatchObject({
        id: attachment.id,
        safetyStatus: "pending_upload",
        uploadStatus: "failed",
      })

      const retry = await uploadReservedContent(client, workspace.id, attachment.id, reservedFile)
      expect(retry.status).toBe(201)

      const url = await getAttachmentDownloadUrl(client, workspace.id, attachment.id)
      const response = await fetch(url)
      expect(await response.text()).toBe(fileContent)
    })

    test("cancel (delete) removes an unsent reservation; content POST then 404s", async () => {
      const { client, workspace } = await setup("reserve-cancel")

      const { attachment } = await reserveAttachment(client, workspace.id, reserveInput)
      await deleteAttachment(client, workspace.id, attachment.id)

      const { status } = await uploadReservedContent(client, workspace.id, attachment.id, reservedFile)
      expect(status).toBe(404)
    })

    test("streams a multipart-sized file (>5MB) through the reservation path", async () => {
      const { client, workspace } = await setup("reserve-large")

      // Above lib-storage's 5MB part threshold multer-s3 switches to S3
      // multipart upload and reports file.size = 0 (no `total` in progress
      // events for streams) — the regression that failed every large mobile
      // photo. Size validation must read the stored object, not multer.
      const big = Buffer.alloc(6 * 1024 * 1024 + 123)
      for (let i = 0; i < big.length; i += 4096) big[i] = i % 251

      const { attachment } = await reserveAttachment(client, workspace.id, {
        filename: "large-photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: big.length,
      })

      const { status, data } = await uploadReservedContent(client, workspace.id, attachment.id, {
        content: big,
        filename: "large-photo.jpg",
        mimeType: "image/jpeg",
      })
      expect({ status, error: (data as { error?: string })?.error }).toEqual({ status: 201, error: undefined })

      const url = await getAttachmentDownloadUrl(client, workspace.id, attachment.id)
      const response = await fetch(url)
      expect(response.ok).toBe(true)
      const downloaded = Buffer.from(await response.arrayBuffer())
      expect(downloaded.length).toBe(big.length)
    }, 60_000)

    test("an E2E reservation never stores the real filename or mime", async () => {
      const { client, workspace } = await setup("reserve-e2e")

      const { attachment } = await reserveAttachment(client, workspace.id, {
        filename: "secret-plans.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        e2e: true,
      })
      expect(attachment.filename).toBe("encrypted")
      expect(attachment.mimeType).toBe("application/octet-stream")
      expect(attachment.e2eOnly).toBe(true)
    })
  })
})
