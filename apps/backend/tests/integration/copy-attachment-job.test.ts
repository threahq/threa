import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { Request, Response } from "express"
import {
  AttachmentSafetyStatuses,
  AttachmentUploadStatuses,
  AuthorTypes,
  StreamTypes,
  bridgeAttachmentResponseSchema,
  bridgeEventsSchema,
  bridgeManifestSchema,
  type AttachmentSafetyStatus,
  type BridgeAttachmentResponse,
  type BridgeEvents,
  type BridgeManifest,
} from "@threahq/types"
import { streamConnectionId } from "@threahq/backend-common"
import { addTestMember, createTestStorage, setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  AttachmentReferenceRepository,
  AttachmentRepository,
  AttachmentService,
  AttachmentUploadRepository,
  createAttachmentHandlers,
} from "../../src/features/attachments"
import { EventService } from "../../src/features/messaging"
import { StreamRepository, StreamService } from "../../src/features/streams"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import {
  BridgeClient,
  StreamConnectionExportService,
  StreamConnectionPullService,
  StreamConnectionRepository,
  createStreamConnectionCopyAttachmentOnDLQ,
  createStreamConnectionCopyAttachmentWorker,
} from "../../src/features/stream-connections"
import type { Job, QueueMessageMeta, StreamConnectionCopyAttachmentJobData } from "../../src/lib/queue"
import {
  attachmentId,
  attachmentReferenceId,
  attachmentUploadId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"
import { MAX_FILE_SIZE } from "../../src/middleware/upload"

/** Answers the partner's bridge calls from the host's export service in-process, parsing each answer as the wire does. */
class DirectBridgeClient extends BridgeClient {
  readonly attachmentCalls: string[] = []

  constructor(private readonly exporter: StreamConnectionExportService) {
    super({ routerUrl: "http://bridge.invalid", apiKey: "unused" })
  }

  override async getManifest(address: Parameters<BridgeClient["getManifest"]>[0]): Promise<BridgeManifest> {
    return bridgeManifestSchema.parse(await this.exporter.getManifest(address))
  }

  override async listEvents(
    address: Parameters<BridgeClient["listEvents"]>[0],
    params: Parameters<BridgeClient["listEvents"]>[1]
  ): Promise<BridgeEvents> {
    return bridgeEventsSchema.parse(await this.exporter.listEvents({ ...address, ...params }))
  }

  override async getAttachment(
    address: Parameters<BridgeClient["getAttachment"]>[0],
    id: string
  ): Promise<BridgeAttachmentResponse> {
    this.attachmentCalls.push(id)
    return bridgeAttachmentResponseSchema.parse(await this.exporter.getAttachment({ ...address, attachmentId: id }))
  }
}

describe("Copying a shared channel's files", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let storage: ReturnType<typeof createTestStorage>
  let exporter: StreamConnectionExportService
  let featureFlagService: FeatureFlagService
  let eventService: EventService
  let attachmentService: AttachmentService

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("copy_attachment_job")
    pool = isolated.pool
    cleanup = isolated.cleanup
    storage = createTestStorage()
    featureFlagService = new FeatureFlagService(pool)
    exporter = new StreamConnectionExportService({ pool, featureFlagService, storage })
    eventService = new EventService(pool)
    attachmentService = new AttachmentService(pool, storage, {
      scan: async () => ({ status: AttachmentSafetyStatuses.CLEAN }),
    } as never)
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedWorkspace(name: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `copyjob-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: "on" })
    return { id, name, adminId: admin.id }
  }

  async function seedChannel(hostId: string, adminId: string, name: string) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: hostId,
      type: "channel",
      slug: `${name}-${crypto.randomUUID().slice(0, 8)}`,
      displayName: name,
      visibility: "public",
      createdBy: adminId,
    })
  }

  async function seedWorld() {
    const host = await seedWorkspace("Copy job host")
    const partner = await seedWorkspace("Copy job partner")
    const channel = await seedChannel(host.id, host.adminId, "shared")
    const outside = await seedChannel(host.id, host.adminId, "outside")
    const connectionId = streamConnectionId()
    await StreamConnectionRepository.applySnapshots(pool, [
      {
        id: connectionId,
        revision: 2,
        state: "active",
        hostWorkspaceId: host.id,
        hostWorkspaceName: host.name,
        hostRegion: "local",
        hostStreamId: channel.id,
        invitedBy: host.adminId,
        partnerWorkspaceId: partner.id,
        partnerWorkspaceName: partner.name,
        partnerRegion: "local",
        partnerVisibility: "private",
        acceptedBy: partner.adminId,
        peerWorkspaceIds: [],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ])
    const bridgeClient = new DirectBridgeClient(exporter)
    const pull = () =>
      new StreamConnectionPullService({ pool, bridgeClient, featureFlagService }).pull({
        workspaceId: partner.id,
        connectionId,
      })
    const hostAddress = { workspaceId: host.id, connectionId, callerWorkspaceId: partner.id }
    const job = (id: string): Job<StreamConnectionCopyAttachmentJobData> => ({
      id: `scfile_${partner.id}_${id}`,
      name: "stream_connection.copy_attachment",
      data: { workspaceId: partner.id, connectionId, attachmentId: id },
    })
    const runJob = (id: string) =>
      createStreamConnectionCopyAttachmentWorker({ pool, bridgeClient, attachmentService, storage })(job(id))
    const giveUp = (id: string) =>
      createStreamConnectionCopyAttachmentOnDLQ({ attachmentService })(pool, job(id), new Error("host unreachable"), {
        failedCount: 20,
        insertedAt: new Date(),
        workspaceId: partner.id,
      } satisfies QueueMessageMeta)
    return { host, partner, channel, outside, connectionId, bridgeClient, pull, hostAddress, runJob, giveUp }
  }

  type World = Awaited<ReturnType<typeof seedWorld>>

  async function hostFile(
    world: World,
    options: { safetyStatus: AttachmentSafetyStatus; bytes?: Buffer; sizeBytes?: number }
  ) {
    const id = attachmentId()
    const filename = "notes.txt"
    const storagePath = `${world.host.id}/${id}/${filename}`
    if (options.bytes) await storage.putObject(storagePath, options.bytes, "text/plain")
    await AttachmentRepository.insert(pool, {
      id,
      workspaceId: world.host.id,
      uploadedBy: world.host.adminId,
      filename,
      mimeType: "text/plain",
      sizeBytes: options.sizeBytes ?? options.bytes?.length ?? 0,
      storagePath,
      safetyStatus: options.safetyStatus,
    })
    return { id, storagePath }
  }

  async function sendWithFiles(world: World, streamIdOfMessage: string, fileIds: string[]) {
    return eventService.createMessage({
      workspaceId: world.host.id,
      streamId: streamIdOfMessage,
      authorId: world.host.adminId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("with files"),
      attachmentIds: fileIds,
    })
  }

  async function sentCleanFile(world: World, bytes = Buffer.from(`bytes-${crypto.randomUUID()}`)) {
    const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, bytes })
    const message = await sendWithFiles(world, world.channel.id, [file.id])
    await world.pull()
    return { ...file, bytes, message, partnerPath: `${world.partner.id}/${file.id}/notes.txt` }
  }

  const partnerState = async (world: World, id: string) => {
    const row = await AttachmentRepository.findById(pool, world.partner.id, id)
    const upload = await AttachmentUploadRepository.findByAttachmentId(pool, world.partner.id, id)
    return { safetyStatus: row?.safetyStatus, upload: upload && { status: upload.status, errorCode: upload.errorCode } }
  }

  const statusEvents = async (world: World, id: string) =>
    (
      await pool.query(
        `SELECT payload FROM outbox WHERE event_type = 'attachment:upload_status_changed'
         AND payload->>'workspaceId' = $1 AND payload->>'attachmentId' = $2 ORDER BY id`,
        [world.partner.id, id]
      )
    ).rows.map((row) => row.payload)

  const objectAt = (path: string) =>
    storage.getObject(path).then(
      (body) => body.toString(),
      () => null
    )

  describe("the host's attachment route", () => {
    test("should answer ready with a url that serves the bytes when the file is clean", async () => {
      const world = await seedWorld()
      const bytes = Buffer.from("clean host bytes")
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, bytes })
      await sendWithFiles(world, world.channel.id, [file.id])

      const answer = await exporter.getAttachment({ ...world.hostAddress, attachmentId: file.id })

      expect({
        status: answer.status,
        body: answer.status === "ready" ? await (await fetch(answer.url)).text() : null,
      }).toEqual({ status: "ready", body: "clean host bytes" })
    })

    test("should answer ready when the file is on a message in a thread under the shared channel", async () => {
      const world = await seedWorld()
      const anchor = await sendWithFiles(world, world.channel.id, [])
      const thread = await StreamRepository.insert(pool, {
        id: streamId(),
        workspaceId: world.host.id,
        type: StreamTypes.THREAD,
        parentStreamId: world.channel.id,
        parentAnchorId: anchor.id,
        rootStreamId: world.channel.id,
        createdBy: world.host.adminId,
      })
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, bytes: Buffer.from("x") })
      await sendWithFiles(world, thread.id, [file.id])

      expect((await exporter.getAttachment({ ...world.hostAddress, attachmentId: file.id })).status).toBe("ready")
    })

    test("should answer pending when the file is still being scanned", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.PENDING_SCAN })
      await sendWithFiles(world, world.channel.id, [file.id])

      expect(await exporter.getAttachment({ ...world.hostAddress, attachmentId: file.id })).toEqual({
        status: "pending",
      })
    })

    test("should answer pending when the file is still uploading", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD })
      await AttachmentUploadRepository.insert(pool, {
        id: attachmentUploadId(),
        workspaceId: world.host.id,
        attachmentId: file.id,
        uploadedBy: world.host.adminId,
        expectedSizeBytes: 10,
      })
      await sendWithFiles(world, world.channel.id, [file.id])

      expect(await exporter.getAttachment({ ...world.hostAddress, attachmentId: file.id })).toEqual({
        status: "pending",
      })
    })

    test("should answer blocked when the host quarantined the file", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN })
      await sendWithFiles(world, world.channel.id, [file.id])
      await pool.query("UPDATE attachments SET safety_status = 'quarantined' WHERE workspace_id = $1 AND id = $2", [
        world.host.id,
        file.id,
      ])

      expect(await exporter.getAttachment({ ...world.hostAddress, attachmentId: file.id })).toEqual({
        status: "blocked",
      })
    })

    test("should answer failed when the host's own upload of the file failed", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD })
      await AttachmentUploadRepository.insert(pool, {
        id: attachmentUploadId(),
        workspaceId: world.host.id,
        attachmentId: file.id,
        uploadedBy: world.host.adminId,
        expectedSizeBytes: 10,
      })
      await sendWithFiles(world, world.channel.id, [file.id])
      await AttachmentUploadRepository.markFailed(pool, world.host.id, file.id, { code: "client_aborted" })

      expect(await exporter.getAttachment({ ...world.hostAddress, attachmentId: file.id })).toEqual({
        status: "failed",
      })
    })

    async function statusOf(world: World, id: string, address = world.hostAddress) {
      return exporter.getAttachment({ ...address, attachmentId: id }).then(
        () => "answered",
        (error: { status?: number }) => error.status
      )
    }

    test("should answer 404 when the attachment id does not exist", async () => {
      const world = await seedWorld()

      expect(await statusOf(world, attachmentId())).toBe(404)
    })

    test("should answer 404 when the attachment is not on any message", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, bytes: Buffer.from("x") })

      expect(await statusOf(world, file.id)).toBe(404)
    })

    test("should answer 404 when the attachment is owned by a message outside the shared tree, even if a shared message re-references it", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, bytes: Buffer.from("x") })
      await sendWithFiles(world, world.outside.id, [file.id])
      const shared = await sendWithFiles(world, world.channel.id, [])
      await AttachmentReferenceRepository.insertMany(pool, [
        {
          id: attachmentReferenceId(),
          workspaceId: world.host.id,
          attachmentId: file.id,
          messageId: shared.id,
          streamId: world.channel.id,
        },
      ])

      expect(await statusOf(world, file.id)).toBe(404)
    })

    test("should answer 404 when the attachment is on a deleted message", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, bytes: Buffer.from("x") })
      const message = await sendWithFiles(world, world.channel.id, [file.id])
      await pool.query("UPDATE messages SET deleted_at = NOW() WHERE workspace_id = $1 AND id = $2", [
        world.host.id,
        message.id,
      ])

      expect(await statusOf(world, file.id)).toBe(404)
    })

    test("should answer 404 when the caller is not the connection's partner", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, bytes: Buffer.from("x") })
      await sendWithFiles(world, world.channel.id, [file.id])

      expect(await statusOf(world, file.id, { ...world.hostAddress, callerWorkspaceId: workspaceId() })).toBe(404)
    })
  })

  describe("the partner's attachment route", () => {
    async function partnerFile(world: World, bytes: Buffer) {
      const id = attachmentId()
      const storagePath = `${world.partner.id}/${id}/notes.txt`
      await storage.putObject(storagePath, bytes, "text/plain")
      await AttachmentRepository.insert(pool, {
        id,
        workspaceId: world.partner.id,
        uploadedBy: world.partner.adminId,
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        storagePath,
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
      })
      return { id, storagePath }
    }

    /** A host message the partner has pulled, with a partner file bound to its copy. */
    async function fileOnCopiedMessage(world: World, bytes: Buffer) {
      const message = await sendWithFiles(world, world.channel.id, [])
      await world.pull()
      const copy = await StreamConnectionRepository.findById(pool, world.partner.id, world.connectionId)
      const file = await partnerFile(world, bytes)
      await AttachmentRepository.attachToMessage(pool, world.partner.id, [file.id], message.id, copy!.streamId)
      return file
    }

    const partnerAddress = (world: World) => ({
      workspaceId: world.partner.id,
      connectionId: world.connectionId,
      callerWorkspaceId: world.host.id,
    })

    async function statusOf(world: World, id: string, address = partnerAddress(world)) {
      return exporter.getAttachment({ ...address, attachmentId: id }).then(
        () => "answered",
        (error: { status?: number }) => error.status
      )
    }

    test("should answer ready with a url that serves the bytes when a partner member's file is on a message in the copy", async () => {
      const world = await seedWorld()
      const file = await fileOnCopiedMessage(world, Buffer.from("partner bytes"))

      const answer = await exporter.getAttachment({ ...partnerAddress(world), attachmentId: file.id })

      expect({
        status: answer.status,
        body: answer.status === "ready" ? await (await fetch(answer.url)).text() : null,
      }).toEqual({ status: "ready", body: "partner bytes" })
    })

    test("should answer 404 when the partner's file is not on a message yet", async () => {
      const world = await seedWorld()
      await world.pull()
      const file = await partnerFile(world, Buffer.from("x"))

      expect(await statusOf(world, file.id)).toBe(404)
    })

    test("should answer 404 when the partner's file is on a message outside the copy", async () => {
      const world = await seedWorld()
      await world.pull()
      const own = await seedChannel(world.partner.id, world.partner.adminId, "own")
      const file = await partnerFile(world, Buffer.from("x"))
      await eventService.createMessage({
        workspaceId: world.partner.id,
        streamId: own.id,
        authorId: world.partner.adminId,
        authorType: AuthorTypes.USER,
        ...testMessageContent("partner only"),
        attachmentIds: [file.id],
      })

      expect(await statusOf(world, file.id)).toBe(404)
    })

    test("should answer 404 when the caller is not the connection's host", async () => {
      const world = await seedWorld()
      const file = await fileOnCopiedMessage(world, Buffer.from("x"))

      expect(await statusOf(world, file.id, { ...partnerAddress(world), callerWorkspaceId: workspaceId() })).toBe(404)
    })

    test("should copy a partner member's file into the host's storage when the host's copy job runs", async () => {
      const world = await seedWorld()
      const file = await fileOnCopiedMessage(world, Buffer.from("partner bytes"))
      const hostPath = `${world.host.id}/${file.id}/notes.txt`
      await AttachmentRepository.insert(pool, {
        id: file.id,
        workspaceId: world.host.id,
        uploadedBy: world.partner.adminId,
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: "partner bytes".length,
        storagePath: hostPath,
        safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD,
      })
      await AttachmentUploadRepository.insert(pool, {
        id: attachmentUploadId(),
        workspaceId: world.host.id,
        attachmentId: file.id,
        uploadedBy: world.partner.adminId,
        expectedSizeBytes: "partner bytes".length,
      })

      await createStreamConnectionCopyAttachmentWorker({
        pool,
        bridgeClient: world.bridgeClient,
        attachmentService,
        storage,
      })({
        id: `scfile_${world.host.id}_${file.id}`,
        name: "stream_connection.copy_attachment",
        data: { workspaceId: world.host.id, connectionId: world.connectionId, attachmentId: file.id },
      })

      const row = await AttachmentRepository.findById(pool, world.host.id, file.id)
      expect({ copied: await objectAt(hostPath), safetyStatus: row?.safetyStatus }).toEqual({
        copied: "partner bytes",
        safetyStatus: "clean",
      })
    })
  })

  describe("the partner's copy job", () => {
    test("should copy the bytes to the partner path, settle the row, drop the upload row and emit the status, when the host file is clean", async () => {
      const world = await seedWorld()
      const file = await sentCleanFile(world)

      await world.runJob(file.id)

      expect({
        copied: await objectAt(file.partnerPath),
        state: await partnerState(world, file.id),
        events: await statusEvents(world, file.id),
      }).toEqual({
        copied: file.bytes.toString(),
        state: { safetyStatus: "clean", upload: null },
        events: [
          {
            workspaceId: world.partner.id,
            attachmentId: file.id,
            uploadStatus: AttachmentUploadStatuses.UPLOADED,
            safetyStatus: "clean",
            streamId: expect.any(String),
            messageId: file.message.id,
          },
        ],
      })
    })

    test("should do nothing when it runs again after the copy succeeded", async () => {
      const world = await seedWorld()
      const file = await sentCleanFile(world)
      await world.runJob(file.id)
      const callsAfterFirstRun = world.bridgeClient.attachmentCalls.length

      await world.runJob(file.id)

      expect({
        calls: world.bridgeClient.attachmentCalls.length,
        state: await partnerState(world, file.id),
        events: (await statusEvents(world, file.id)).length,
      }).toEqual({ calls: callsAfterFirstRun, state: { safetyStatus: "clean", upload: null }, events: 1 })
    })

    test("should fail the run and write nothing when the host is still scanning the file", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, {
        safetyStatus: AttachmentSafetyStatuses.PENDING_SCAN,
        bytes: Buffer.from("not yet"),
      })
      await sendWithFiles(world, world.channel.id, [file.id])
      await world.pull()

      await expect(world.runJob(file.id)).rejects.toThrow(`The other side has not finished attachment ${file.id}`)

      expect({
        copied: await objectAt(`${world.partner.id}/${file.id}/notes.txt`),
        state: await partnerState(world, file.id),
        events: await statusEvents(world, file.id),
      }).toEqual({
        copied: null,
        state: { safetyStatus: "pending_upload", upload: { status: "reserved", errorCode: null } },
        events: [],
      })
    })

    test("should quarantine the copy and emit the status when the host blocks the file after the pull", async () => {
      const world = await seedWorld()
      const file = await sentCleanFile(world)
      await pool.query("UPDATE attachments SET safety_status = 'quarantined' WHERE workspace_id = $1 AND id = $2", [
        world.host.id,
        file.id,
      ])

      await world.runJob(file.id)

      expect({
        copied: await objectAt(file.partnerPath),
        state: await partnerState(world, file.id),
        events: (await statusEvents(world, file.id)).map((event) => event.safetyStatus),
      }).toEqual({ copied: null, state: { safetyStatus: "quarantined", upload: null }, events: ["quarantined"] })
    })

    test("should mark the copy failed and emit the status when the host's own upload of the file failed", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD, sizeBytes: 10 })
      await AttachmentUploadRepository.insert(pool, {
        id: attachmentUploadId(),
        workspaceId: world.host.id,
        attachmentId: file.id,
        uploadedBy: world.host.adminId,
        expectedSizeBytes: 10,
      })
      await sendWithFiles(world, world.channel.id, [file.id])
      await world.pull()
      await AttachmentUploadRepository.markFailed(pool, world.host.id, file.id, { code: "client_aborted" })

      await world.runJob(file.id)

      expect({
        state: await partnerState(world, file.id),
        events: (await statusEvents(world, file.id)).map((event) => event.uploadStatus),
      }).toEqual({
        state: { safetyStatus: "pending_upload", upload: { status: "failed", errorCode: "copy_failed" } },
        events: ["failed"],
      })
    })

    test("should mark the copy failed without asking the host when the connection is no longer active", async () => {
      const world = await seedWorld()
      const file = await sentCleanFile(world)
      await pool.query("UPDATE stream_connections SET state = 'revoked' WHERE workspace_id = $1 AND id = $2", [
        world.partner.id,
        world.connectionId,
      ])
      const callsBefore = world.bridgeClient.attachmentCalls.length

      await world.runJob(file.id)

      expect({
        calls: world.bridgeClient.attachmentCalls.length - callsBefore,
        state: await partnerState(world, file.id),
        events: (await statusEvents(world, file.id)).map((event) => event.uploadStatus),
      }).toEqual({
        calls: 0,
        state: { safetyStatus: "pending_upload", upload: { status: "failed", errorCode: "copy_failed" } },
        events: ["failed"],
      })
    })

    test("should mark the copy failed without asking the host when the file is over this region's size cap", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, sizeBytes: MAX_FILE_SIZE + 1 })
      await sendWithFiles(world, world.channel.id, [file.id])
      await world.pull()
      const callsBefore = world.bridgeClient.attachmentCalls.length

      await world.runJob(file.id)

      expect({
        calls: world.bridgeClient.attachmentCalls.length - callsBefore,
        state: await partnerState(world, file.id),
      }).toEqual({
        calls: 0,
        state: { safetyStatus: "pending_upload", upload: { status: "failed", errorCode: "copy_failed" } },
      })
    })

    test("should refuse the bytes and leave the row waiting when the host object is shorter than the size its message declares", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, {
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        bytes: Buffer.from("half"),
        sizeBytes: 8,
      })
      await sendWithFiles(world, world.channel.id, [file.id])
      await world.pull()

      await expect(world.runJob(file.id)).rejects.toThrow("Remote file is 4 bytes, not the 8 its message declares")

      expect({
        copied: await objectAt(`${world.partner.id}/${file.id}/notes.txt`),
        state: await partnerState(world, file.id),
      }).toEqual({
        copied: null,
        state: { safetyStatus: "pending_upload", upload: { status: "reserved", errorCode: null } },
      })
    })

    test("should refuse the bytes and leave the row waiting when the host object is larger than the size its message declares", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, {
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        bytes: Buffer.alloc(64, "a"),
        sizeBytes: 8,
      })
      await sendWithFiles(world, world.channel.id, [file.id])
      await world.pull()

      await expect(world.runJob(file.id)).rejects.toThrow("larger than the 8 bytes")

      expect({
        copied: await objectAt(`${world.partner.id}/${file.id}/notes.txt`),
        state: await partnerState(world, file.id),
      }).toEqual({
        copied: null,
        state: { safetyStatus: "pending_upload", upload: { status: "reserved", errorCode: null } },
      })
    })

    test("should stop reading and leave the row waiting when the host streams more bytes than declared without a Content-Length", async () => {
      const world = await seedWorld()
      const file = await hostFile(world, { safetyStatus: AttachmentSafetyStatuses.CLEAN, sizeBytes: 8 })
      await sendWithFiles(world, world.channel.id, [file.id])
      await world.pull()
      let served = 0
      const host = Bun.serve({
        port: 0,
        fetch: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                if (served >= 1_000_000) return controller.close()
                served += 1024
                controller.enqueue(new Uint8Array(1024))
                await new Promise((resolve) => setTimeout(resolve, 1))
              },
            })
          ),
      })
      world.bridgeClient.getAttachment = async () => ({ status: "ready", url: `http://localhost:${host.port}/` })

      try {
        await expect(world.runJob(file.id)).rejects.toThrow("larger than the 8 bytes")
      } finally {
        host.stop(true)
      }

      expect({
        copied: await objectAt(`${world.partner.id}/${file.id}/notes.txt`),
        state: await partnerState(world, file.id),
        readWholeBody: served >= 1_000_000,
      }).toEqual({
        copied: null,
        state: { safetyStatus: "pending_upload", upload: { status: "reserved", errorCode: null } },
        readWholeBody: false,
      })
    })

    test("should mark the upload failed and emit once when the job runs out of retries, however often the hook runs", async () => {
      const world = await seedWorld()
      const file = await sentCleanFile(world)

      await world.giveUp(file.id)
      await world.giveUp(file.id)

      expect({
        state: await partnerState(world, file.id),
        events: (await statusEvents(world, file.id)).map((event) => ({
          uploadStatus: event.uploadStatus,
          safetyStatus: event.safetyStatus,
        })),
      }).toEqual({
        state: { safetyStatus: "pending_upload", upload: { status: "failed", errorCode: "copy_failed" } },
        events: [{ uploadStatus: "failed", safetyStatus: "pending_upload" }],
      })
    })

    function downloadUrlRequest(world: World, caller: string, id: string) {
      const handlers = createAttachmentHandlers({
        attachmentService,
        streamService: new StreamService(pool),
        storage,
        pool,
      })
      const answer: { status: number; body: unknown } = { status: 200, body: undefined }
      const res = {
        locals: {},
        status(code: number) {
          answer.status = code
          return res
        },
        json(body: unknown) {
          answer.body = body
          return res
        },
      } as unknown as Response
      const req = { user: { id: caller }, workspaceId: world.partner.id, params: { attachmentId: id }, query: {} }
      return handlers.getDownloadUrl(req as unknown as Request, res).then(() => answer)
    }

    test("should answer the in-app download route for a member of the copy with a url that serves the copied bytes", async () => {
      const world = await seedWorld()
      const file = await sentCleanFile(world)
      await world.runJob(file.id)

      const answer = await downloadUrlRequest(world, world.partner.adminId, file.id)

      const { url } = answer.body as { url: string }
      expect({ status: answer.status, served: await (await fetch(url)).text() }).toEqual({
        status: 200,
        served: file.bytes.toString(),
      })
    })

    test("should refuse the in-app download route for a partner user who is not a member of the copy", async () => {
      const world = await seedWorld()
      const file = await sentCleanFile(world)
      await world.runJob(file.id)
      const outsider = await addTestMember(pool, world.partner.id, `outsider-${crypto.randomUUID()}`)

      const answer = await downloadUrlRequest(world, outsider.id, file.id)

      expect(answer).toEqual({ status: 403, body: { error: "Access denied" } })
    })
  })
})
