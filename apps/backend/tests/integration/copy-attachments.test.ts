import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AttachmentSafetyStatuses,
  AuthorTypes,
  bridgeEventsSchema,
  bridgeManifestSchema,
  type AttachmentSafetyStatus,
  type BridgeEvents,
  type BridgeManifest,
} from "@threahq/types"
import { streamConnectionId } from "@threahq/backend-common"
import { addTestMember, setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { AttachmentRepository } from "../../src/features/attachments"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import {
  BridgeClient,
  StreamConnectionExportService,
  StreamConnectionPullService,
  StreamConnectionRepository,
} from "../../src/features/stream-connections"
import { attachmentId, streamId, userId, workspaceId } from "../../src/lib/id"

/** Answers the partner's bridge calls from the host's export service in-process. */
class DirectBridgeClient extends BridgeClient {
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
}

describe("Attachments in a shared channel's copy", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let exporter: StreamConnectionExportService
  let featureFlagService: FeatureFlagService
  let eventService: EventService

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("copy_attachments")
    pool = isolated.pool
    cleanup = isolated.cleanup
    featureFlagService = new FeatureFlagService(pool)
    exporter = new StreamConnectionExportService({ pool, featureFlagService })
    eventService = new EventService(pool)
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedWorkspace(name: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `files-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: "on" })
    return { id, name, adminId: admin.id }
  }

  async function seedWorld() {
    const host = await seedWorkspace("Files host")
    const partner = await seedWorkspace("Files partner")
    const channel = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: host.id,
      type: "channel",
      slug: `files-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Files",
      visibility: "public",
      createdBy: host.adminId,
    })
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
    const pull = () =>
      new StreamConnectionPullService({
        pool,
        bridgeClient: new DirectBridgeClient(exporter),
        featureFlagService,
      }).pull({ workspaceId: partner.id, connectionId })
    return { host, partner, channel, connectionId, pull }
  }

  type World = Awaited<ReturnType<typeof seedWorld>>

  async function hostFile(
    world: World,
    filename: string,
    safetyStatus: AttachmentSafetyStatus,
    dimensions?: { width: number; height: number }
  ) {
    const id = attachmentId()
    await AttachmentRepository.insert(pool, {
      id,
      workspaceId: world.host.id,
      uploadedBy: world.host.adminId,
      filename,
      mimeType: dimensions ? "image/png" : "application/pdf",
      sizeBytes: 2048,
      storagePath: `${world.host.id}/${id}/${filename}`,
      safetyStatus: safetyStatus === AttachmentSafetyStatuses.QUARANTINED ? "clean" : safetyStatus,
    })
    if (dimensions) {
      await pool.query("UPDATE attachments SET width = $3, height = $4 WHERE workspace_id = $1 AND id = $2", [
        world.host.id,
        id,
        dimensions.width,
        dimensions.height,
      ])
    }
    return { id, filename, safetyStatus }
  }

  async function sendWithFiles(world: World, text: string, files: { id: string; safetyStatus: string }[]) {
    const message = await eventService.createMessage({
      workspaceId: world.host.id,
      streamId: world.channel.id,
      authorId: world.host.adminId,
      authorType: AuthorTypes.USER,
      ...testMessageContent(text),
      attachmentIds: files.map((file) => file.id),
    })
    for (const file of files.filter((f) => f.safetyStatus === AttachmentSafetyStatuses.QUARANTINED)) {
      await pool.query("UPDATE attachments SET safety_status = 'quarantined' WHERE workspace_id = $1 AND id = $2", [
        world.host.id,
        file.id,
      ])
    }
    return message
  }

  const partnerRows = async (world: World) => {
    const q = async (text: string) => (await pool.query(text, [world.partner.id])).rows
    return {
      attachments: await q(
        `SELECT id, workspace_id, stream_id, message_id, uploaded_by, filename, mime_type, size_bytes::int AS size_bytes,
                storage_provider, storage_path, processing_status, safety_status, width, height, e2e_only,
                thumbnail_storage_path
         FROM attachments WHERE workspace_id = $1 ORDER BY filename`
      ),
      uploads: await q(
        `SELECT attachment_id, uploaded_by, status, expected_size_bytes::int AS expected_size_bytes
         FROM attachment_uploads WHERE workspace_id = $1 ORDER BY attachment_id`
      ),
      references: await q(
        `SELECT attachment_id, message_id, stream_id FROM attachment_references WHERE workspace_id = $1
         ORDER BY attachment_id`
      ),
      jobs: await q(
        `SELECT id, queue_name, payload FROM queue_messages
         WHERE workspace_id = $1 AND queue_name = 'stream_connection.copy_attachment' ORDER BY id`
      ),
      context: await q(
        `SELECT category, ref_id, source_message_id FROM stream_context_items
         WHERE workspace_id = $1 AND category IN ('media', 'file') ORDER BY ref_id`
      ),
    }
  }

  async function createdPayload(world: World, messageId: string) {
    const { rows } = await pool.query(
      `SELECT payload FROM stream_events
       WHERE workspace_id = $1 AND event_type = 'message_created' AND payload->>'messageId' = $2`,
      [world.partner.id, messageId]
    )
    return rows.map((row) => ({
      ...row.payload,
      attachments: [...row.payload.attachments].sort((a, b) => a.filename.localeCompare(b.filename)),
    }))
  }

  const byAttachmentId = <T extends { attachment_id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => a.attachment_id.localeCompare(b.attachment_id))

  test("should write a bound row per host file, an upload row and a copy job per pending one, when the partner pulls a message with a clean, a pending-scan and a quarantined file", async () => {
    const world = await seedWorld()
    const clean = await hostFile(world, "a-photo.png", AttachmentSafetyStatuses.CLEAN, { width: 640, height: 480 })
    const scanning = await hostFile(world, "b-report.pdf", AttachmentSafetyStatuses.PENDING_SCAN)
    const blocked = await hostFile(world, "c-malware.pdf", AttachmentSafetyStatuses.QUARANTINED)
    const message = await sendWithFiles(world, "three files", [clean, scanning, blocked])

    await world.pull()

    const copyOf = (file: { id: string; filename: string }, safetyStatus: string, extra: object = {}) => ({
      id: file.id,
      workspace_id: world.partner.id,
      stream_id: world.channel.id,
      message_id: message.id,
      uploaded_by: world.host.adminId,
      filename: file.filename,
      mime_type: "application/pdf",
      size_bytes: 2048,
      storage_provider: "s3",
      storage_path: `${world.partner.id}/${file.id}/${file.filename}`,
      processing_status: "skipped",
      safety_status: safetyStatus,
      width: null,
      height: null,
      e2e_only: false,
      thumbnail_storage_path: null,
      ...extra,
    })
    const upload = (file: { id: string }) => ({
      attachment_id: file.id,
      uploaded_by: world.host.adminId,
      status: "reserved",
      expected_size_bytes: 2048,
    })
    const job = (file: { id: string }) => ({
      id: `scfile_${world.partner.id}_${file.id}`,
      queue_name: "stream_connection.copy_attachment",
      payload: { workspaceId: world.partner.id, connectionId: world.connectionId, attachmentId: file.id },
    })
    expect(await partnerRows(world)).toEqual({
      attachments: [
        copyOf(clean, "pending_upload", { mime_type: "image/png", width: 640, height: 480 }),
        copyOf(scanning, "pending_upload"),
        copyOf(blocked, "quarantined"),
      ],
      uploads: byAttachmentId([upload(clean), upload(scanning)]),
      references: byAttachmentId(
        [clean, scanning, blocked].map((file) => ({
          attachment_id: file.id,
          message_id: message.id,
          stream_id: world.channel.id,
        }))
      ),
      jobs: [job(clean), job(scanning)].sort((a, b) => a.id.localeCompare(b.id)),
      context: [
        { category: "media", ref_id: clean.id, source_message_id: message.id },
        { category: "file", ref_id: scanning.id, source_message_id: message.id },
        { category: "file", ref_id: blocked.id, source_message_id: message.id },
      ].sort((a, b) => a.ref_id.localeCompare(b.ref_id)),
    })
    expect(await createdPayload(world, message.id)).toEqual([
      expect.objectContaining({
        messageId: message.id,
        attachments: [
          {
            id: clean.id,
            filename: "a-photo.png",
            mimeType: "image/png",
            sizeBytes: 2048,
            safetyStatus: "pending_upload",
            uploadStatus: "reserved",
            width: 640,
            height: 480,
          },
          {
            id: scanning.id,
            filename: "b-report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2048,
            safetyStatus: "pending_upload",
            uploadStatus: "reserved",
          },
          {
            id: blocked.id,
            filename: "c-malware.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2048,
            safetyStatus: "quarantined",
          },
        ],
      }),
    ])
  })

  test("should create nothing new when the same page is applied again", async () => {
    const world = await seedWorld()
    const file = await hostFile(world, "once.pdf", AttachmentSafetyStatuses.CLEAN)
    await sendWithFiles(world, "one file", [file])
    await world.pull()
    const before = await partnerRows(world)

    await pool.query("DELETE FROM stream_connection_cursors WHERE workspace_id = $1", [world.partner.id])
    await world.pull()

    expect(await partnerRows(world)).toEqual(before)
    expect(before.attachments).toHaveLength(1)
  })

  test("should refuse the page and leave no copy message when it names an attachment the partner already owns", async () => {
    const world = await seedWorld()
    const file = await hostFile(world, "host-name.pdf", AttachmentSafetyStatuses.CLEAN)
    const message = await sendWithFiles(world, "taken id", [file])
    await AttachmentRepository.insert(pool, {
      id: file.id,
      workspaceId: world.partner.id,
      uploadedBy: world.partner.adminId,
      filename: "partner-own.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      storagePath: `${world.partner.id}/${file.id}/partner-own.pdf`,
      safetyStatus: AttachmentSafetyStatuses.CLEAN,
    })

    await expect(world.pull()).rejects.toThrow()

    const rows = await partnerRows(world)
    expect({
      copy: await MessageRepository.findById(pool, world.partner.id, message.id),
      attachments: rows.attachments.map(({ id, filename, message_id }) => ({ id, filename, message_id })),
      uploads: rows.uploads,
      jobs: rows.jobs,
    }).toEqual({
      copy: null,
      attachments: [{ id: file.id, filename: "partner-own.pdf", message_id: null }],
      uploads: [],
      jobs: [],
    })
  })

  test("should refuse a wire attachment when its id is not an attachment id", () => {
    const page = {
      changes: [],
      users: [],
      cursor: "0",
      hasMore: false,
    }
    const withAttachment = (id: string) => ({
      ...page,
      changes: [
        {
          kind: "message",
          message: {
            id: "msg_1",
            streamId: "stream_1",
            authorId: "usr_1",
            authorType: "user",
            contentJson: { type: "doc", content: [] },
            contentMarkdown: "",
            reactions: {},
            revision: 1,
            editedAt: null,
            createdAt: new Date().toISOString(),
            attachments: [{ id, filename: "f", mimeType: "text/plain", sizeBytes: 1, safetyStatus: "clean" }],
          },
        },
      ],
    })

    expect(bridgeEventsSchema.safeParse(withAttachment("attach_01ABC")).success).toBe(true)
    expect(bridgeEventsSchema.safeParse(withAttachment("usr_01ABC")).success).toBe(false)
    expect(bridgeEventsSchema.safeParse(withAttachment("attach_x/../y")).success).toBe(false)
  })
})
