import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import {
  AttachmentSafetyStatuses,
  ConversationIntents,
  E2E_PLACEHOLDER_CONTENT_MARKDOWN,
  sharedMessageSlotKey,
} from "@threa/types"
import { EventService } from "./event-service"
import { MessageRepository } from "./repository"
import { SharedMessageRepository } from "./sharing/repository"
import * as sharing from "./sharing"
import { MessageVersionRepository } from "./version-repository"
import * as streamsModule from "../streams"
import {
  StreamEventRepository,
  StreamMemberRepository,
  StreamRepository,
  SparseReadRepository,
  ReadStateRepository,
  type StreamEvent,
} from "../streams"
import { AttachmentRepository, AttachmentReferenceRepository, AttachmentUploadRepository } from "../attachments"
import { OutboxRepository } from "../../lib/outbox"
import { OperationLeaseRepository } from "../../lib/operation-leases"
import * as db from "../../db"
import { messagesTotal } from "../../lib/observability"
import { StreamPersonaParticipantRepository } from "../agents"
import { DraftsRepository } from "../drafts"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamContextRepository } from "../stream-context"

// The suites below drive the service with a bare `{}` client, so the
// "In this stream" projection writes are stubbed globally; the suite that
// asserts them re-spies with its own recorders.
beforeEach(() => {
  spyOn(StreamContextRepository, "insertMany").mockResolvedValue(0)
  spyOn(StreamContextRepository, "replaceForMessage").mockResolvedValue(0)
  spyOn(StreamContextRepository, "deleteByMessageId").mockResolvedValue(0)
  spyOn(StreamContextRepository, "reparentMessages").mockResolvedValue(0)
})

describe("EventService attachment safety checks", () => {
  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", type: "scratchpad" } as any)
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(AttachmentRepository, "attachToMessage").mockResolvedValue(0)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    spyOn(messagesTotal, "inc").mockImplementation(() => undefined)
  })

  afterEach(() => {
    mock.restore()
  })

  it("rejects attachments that are not malware-scan clean", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_1",
        workspaceId: "ws_1",
        streamId: null,
        messageId: null,
        safetyStatus: AttachmentSafetyStatuses.QUARANTINED,
        filename: "unsafe.exe",
        mimeType: "application/octet-stream",
        sizeBytes: 10,
      },
    ] as any)

    const service = new EventService({} as any)

    await expect(
      service.createMessage({
        workspaceId: "ws_1",
        streamId: "stream_1",
        authorId: "usr_1",
        authorType: "user",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "hello",
        attachmentIds: ["attach_1"],
      })
    ).rejects.toThrow("Invalid attachment IDs: must be malware-scan clean")

    expect(AttachmentRepository.attachToMessage).not.toHaveBeenCalled()
  })

  it("rejects binding a plaintext attachment to a sealed message (INV-E1 backstop)", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_plain",
        workspaceId: "ws_1",
        streamId: null,
        messageId: null,
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        e2eOnly: false,
        filename: "real-name-would-leak.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
      },
    ] as any)
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      type: "scratchpad",
      e2eEnabled: true,
    } as any)

    const service = new EventService({} as any)
    await expect(
      service.createMessage({
        workspaceId: "ws_1",
        streamId: "stream_1",
        authorId: "usr_1",
        authorType: "user",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
        ciphertext: Buffer.from("opaque-bytes"),
        envelope: { v: 2, keyGeneration: 0, iv: "AAAA", aad: "AAAA" },
        e2eVersion: 2,
        attachmentIds: ["attach_plain"],
      })
    ).rejects.toThrow("a sealed message can only bind E2E attachments")
    expect(AttachmentRepository.attachToMessage).not.toHaveBeenCalled()
  })

  it("rejects binding an E2E attachment to a plaintext message (INV-E1 backstop)", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_e2e",
        workspaceId: "ws_1",
        streamId: null,
        messageId: null,
        safetyStatus: AttachmentSafetyStatuses.E2E_UNSCANNED,
        e2eOnly: true,
        filename: "encrypted",
        mimeType: "application/octet-stream",
        sizeBytes: 10,
      },
    ] as any)

    const service = new EventService({} as any)
    await expect(
      service.createMessage({
        workspaceId: "ws_1",
        streamId: "stream_1",
        authorId: "usr_1",
        authorType: "user",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "hello",
        attachmentIds: ["attach_e2e"],
      })
    ).rejects.toThrow("an E2E attachment can only be bound to a sealed message")
    expect(AttachmentRepository.attachToMessage).not.toHaveBeenCalled()
  })

  it("binds a fresh E2E (e2e_unscanned) ciphertext attachment to the message", async () => {
    // The opaque attachment row: placeholder name/mime, never scanned, not yet
    // owned by a message. The E2E create path must still attach it.
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_e2e",
        workspaceId: "ws_1",
        streamId: null,
        messageId: null,
        safetyStatus: AttachmentSafetyStatuses.E2E_UNSCANNED,
        e2eOnly: true,
        filename: "encrypted",
        mimeType: "application/octet-stream",
        sizeBytes: 1234,
      },
    ] as any)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 1n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: null,
      sentVia: null,
      reactions: {},
      metadata: {},
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(AttachmentReferenceRepository, "insertMany").mockResolvedValue(0)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    // One fresh row to attach → the bind call reports one row updated.
    spyOn(AttachmentRepository, "attachToMessage").mockResolvedValue(1)
    // Ciphertext send → the sink (INV-E1) requires the target stream to be E2E.
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      type: "scratchpad",
      e2eEnabled: true,
    } as any)

    const service = new EventService({} as any)
    await service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: "user",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
      ciphertext: Buffer.from("opaque-bytes"),
      envelope: { v: 2, keyGeneration: 0, iv: "AAAA", aad: "AAAA" },
      e2eVersion: 2,
      attachmentIds: ["attach_e2e"],
    })

    // Bind the fresh e2e_unscanned row to this message: (client, ids, msgId, streamId).
    expect(AttachmentRepository.attachToMessage).toHaveBeenCalledWith(
      expect.anything(),
      ["attach_e2e"],
      expect.stringMatching(/^msg_/),
      "stream_1"
    )
  })

  // Shared plumbing for the pending-reservation (send-while-uploading) cases.
  const pendingRow = (overrides: Record<string, unknown> = {}) => ({
    id: "attach_pending",
    workspaceId: "ws_1",
    streamId: null,
    messageId: null,
    uploadedBy: "usr_1",
    safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD,
    e2eOnly: false,
    filename: "large.mov",
    mimeType: "video/quicktime",
    sizeBytes: 1234,
    ...overrides,
  })

  const mockCreateMessagePlumbing = () => {
    const insertedEvents: any[] = []
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => {
      insertedEvents.push(params)
      return {
        id: "evt_1",
        streamId: params.streamId,
        sequence: 1n,
        eventType: params.eventType,
        payload: params.payload,
        actorId: params.actorId,
        actorType: params.actorType,
        createdAt: new Date(),
      }
    }) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: null,
      sentVia: null,
      reactions: {},
      metadata: {},
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(AttachmentReferenceRepository, "insertMany").mockResolvedValue(0)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(AttachmentRepository, "attachToMessage").mockResolvedValue(1)
    return insertedEvents
  }

  const sendPending = (service: EventService) =>
    service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: "user",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hello",
      attachmentIds: ["attach_pending"],
    })

  it("binds the author's own pending reservation and stamps live upload state on the summary", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([pendingRow()] as any)
    spyOn(AttachmentUploadRepository, "findByAttachmentIds").mockResolvedValue(
      new Map([["attach_pending", { attachmentId: "attach_pending", status: "uploading" } as any]])
    )
    const insertedEvents = mockCreateMessagePlumbing()

    const service = new EventService({} as any)
    await sendPending(service)

    expect(AttachmentRepository.attachToMessage).toHaveBeenCalledWith(
      expect.anything(),
      ["attach_pending"],
      expect.stringMatching(/^msg_/),
      "stream_1"
    )
    // The payload carries the pending state so viewers render an inert status
    // chip, not a broken preview.
    expect(insertedEvents[0].payload.attachments).toEqual([
      expect.objectContaining({
        id: "attach_pending",
        safetyStatus: AttachmentSafetyStatuses.PENDING_UPLOAD,
        uploadStatus: "uploading",
      }),
    ])
  })

  it("summaries reflect a settle that lands between validation and bind (re-read after attach)", async () => {
    // First read (validation) sees pending; the re-read after attachToMessage
    // sees the concurrently-committed settle. The payload must carry the
    // settled state — that settle's status event was skipped (row was unbound).
    spyOn(AttachmentRepository, "findByIds")
      .mockResolvedValueOnce([pendingRow()] as any)
      .mockResolvedValueOnce([pendingRow({ safetyStatus: AttachmentSafetyStatuses.CLEAN })] as any)
    const findUploads = spyOn(AttachmentUploadRepository, "findByAttachmentIds").mockResolvedValue(new Map())
    const insertedEvents = mockCreateMessagePlumbing()

    const service = new EventService({} as any)
    await sendPending(service)

    const summary = insertedEvents[0].payload.attachments[0]
    expect(summary.safetyStatus).toBeUndefined()
    expect(summary.uploadStatus).toBeUndefined()
    // The settled row no longer queries the tracking table for its status.
    expect(findUploads).toHaveBeenCalledWith(expect.anything(), "ws_1", [])
  })

  it("rejects a pending reservation owned by another author", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([pendingRow({ uploadedBy: "usr_other" })] as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)

    const service = new EventService({} as any)
    await expect(sendPending(service)).rejects.toThrow("this author's own pending upload")
    expect(AttachmentRepository.attachToMessage).not.toHaveBeenCalled()
  })

  it("rejects a pending attachment already bound to another message", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([pendingRow({ messageId: "msg_other" })] as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)

    const service = new EventService({} as any)
    await expect(sendPending(service)).rejects.toThrow("this author's own pending upload")
    expect(AttachmentRepository.attachToMessage).not.toHaveBeenCalled()
  })

  it("allows re-referencing an attachment the author can already read and skips re-attach", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_1",
        workspaceId: "ws_1",
        streamId: "stream_source",
        messageId: "msg_source",
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        filename: "shared.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
    ] as any)
    // checkStreamAccess() resolves to the source stream as long as the
    // stream row exists and is public (or the user is a member).
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_source",
      workspaceId: "ws_1",
      rootStreamId: null,
      visibility: "public",
      type: "channel",
    } as any)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 1n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: null,
      sentVia: null,
      reactions: {},
      metadata: {},
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    const insertManySpy = spyOn(AttachmentReferenceRepository, "insertMany").mockResolvedValue(0)

    const service = new EventService({} as any)
    await service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_target",
      authorId: "usr_1",
      authorType: "user",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "resending image",
      attachmentIds: ["attach_1"],
    })

    expect(AttachmentRepository.attachToMessage).not.toHaveBeenCalled()
    expect(insertManySpy).toHaveBeenCalledTimes(1)
    expect(insertManySpy.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ attachmentId: "attach_1", streamId: "stream_target" }),
    ])
  })

  it("rejects re-referencing an attachment the author cannot read", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_1",
        workspaceId: "ws_1",
        streamId: "stream_secret",
        messageId: "msg_secret",
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        filename: "secret.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
    ] as any)
    // No matching stream → checkStreamAccess returns null.
    spyOn(StreamRepository, "findById").mockResolvedValue(null)
    spyOn(SharedMessageRepository, "listSourcesGrantedToViewer").mockResolvedValue(new Set())
    spyOn(AttachmentReferenceRepository, "hasViewerAccessByReference").mockResolvedValue(false)

    const service = new EventService({} as any)
    await expect(
      service.createMessage({
        workspaceId: "ws_1",
        streamId: "stream_target",
        authorId: "usr_1",
        authorType: "user",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "stealing",
        attachmentIds: ["attach_1"],
      })
    ).rejects.toThrow("cannot reference an attachment without read access")
  })

  it("uses accessibleStreamIds set-membership for the read-access check (persona path) and skips userId membership lookups", async () => {
    // Regression for staging bug: persona-authored messages with inline
    // attachment references blew up with "cannot reference an attachment
    // without read access" because `checkStreamAccess` looked up the persona
    // id in `stream_members` (where it never appears). The fix: when the
    // agent layer passes `accessibleStreamIds` (= scope-restricted
    // `AgentAccessSpec` reach), the gate becomes pure set membership and
    // does NOT query `stream_members` keyed by the persona id at all.
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_1",
        workspaceId: "ws_1",
        streamId: "stream_source",
        messageId: "msg_source",
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        filename: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
    ] as any)
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_target",
      workspaceId: "ws_1",
      rootStreamId: null,
      visibility: "private",
      type: "channel",
    } as any)
    const isMemberSpy = spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue([])
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 1n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      timestamp: new Date(),
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "insert").mockResolvedValue({ id: "msg_new" } as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(AttachmentReferenceRepository, "insertMany").mockResolvedValue(0)

    const service = new EventService({} as any)
    await service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_target",
      authorId: "persona_ariadne",
      authorType: "persona",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "Resurfacing the diagram",
      attachmentIds: ["attach_1"],
      // Source stream is in scope — direct set-membership lets it through.
      accessibleStreamIds: ["stream_target", "stream_source"],
    })

    // The persona id must never be used as a `stream_members` lookup key.
    // (Step 0 / step 6 stream-update rows that touch isMember legitimately
    // exist for the *target* stream, but never with the persona id as the
    // member id.)
    for (const call of isMemberSpy.mock.calls) {
      expect(call[2]).not.toBe("persona_ariadne")
    }
  })

  it("rejects persona-authored references whose source stream is outside the agent's scope", async () => {
    // The agent's `accessibleStreamIds` is scope-restricted by
    // `AgentAccessSpec` (e.g. a public-channel agent only sees public
    // streams). An attachment whose source stream isn't in scope and has no
    // referencing rows inside scope must fail the gate even though the
    // invoking user might have full access to it from elsewhere.
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_secret",
        workspaceId: "ws_1",
        streamId: "stream_secret",
        messageId: "msg_secret",
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        filename: "secret.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
    ] as any)
    spyOn(StreamRepository, "findById").mockResolvedValue(null)
    const findRefsSpy = spyOn(AttachmentReferenceRepository, "findReferencingStreamIds").mockResolvedValue([])

    const service = new EventService({} as any)
    await expect(
      service.createMessage({
        workspaceId: "ws_1",
        streamId: "stream_target",
        authorId: "persona_ariadne",
        authorType: "persona",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "leaking",
        attachmentIds: ["attach_secret"],
        accessibleStreamIds: ["stream_target"],
      })
    ).rejects.toThrow("cannot reference an attachment without read access")

    expect(findRefsSpy).toHaveBeenCalled()
  })
})

describe("EventService.editMessage version capture", () => {
  const existingMessage = {
    id: "msg_1",
    streamId: "stream_1",
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "original" }] }] },
    contentMarkdown: "original",
    authorId: "usr_1",
    authorType: "user",
    revision: 2,
  }
  let findByIdForUpdateSpy: ReturnType<typeof spyOn>
  let isMemberSpy: ReturnType<typeof spyOn>
  let hasParticipatedSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    findByIdForUpdateSpy = spyOn(MessageRepository, "findByIdForUpdate").mockResolvedValue(existingMessage as any)
    spyOn(MessageRepository, "findById").mockResolvedValue(existingMessage as any)
    // editMessageInternal refuses edits in E2E streams at the sink (INV-E1); default to
    // non-E2E so the plaintext edit path runs.
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    // editMessageInternal looks up the stream post-edit to decide whether to publish a
    // thread-summary update to the parent (for reply edits). Default to a
    // non-thread stream so the emitThreadUpdate branch short-circuits
    // — tests that care about the thread path can override per case.
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      type: "scratchpad",
      parentStreamId: null,
      parentMessageId: null,
    } as any)
    isMemberSpy = spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    hasParticipatedSpy = spyOn(StreamPersonaParticipantRepository, "hasParticipated").mockResolvedValue(false)
    spyOn(MessageVersionRepository, "insert").mockResolvedValue({
      id: "msgv_1",
      messageId: "msg_1",
      versionNumber: 1,
      contentJson: existingMessage.contentJson,
      contentMarkdown: "original",
      editedBy: "usr_1",
      createdAt: new Date(),
    })
    spyOn(StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_1",
      streamId: "stream_1",
      sequence: 2n,
      eventType: "message_edited",
      payload: {},
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(),
    } as any)
    spyOn(MessageRepository, "updateContent").mockResolvedValue({
      ...existingMessage,
      contentMarkdown: "edited",
      editedAt: new Date(),
    } as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(SharedMessageRepository, "insert").mockResolvedValue({} as any)
    // Edit path also refreshes the attachment_references projection in the same
    // transaction; default mocks let the version-capture tests run without
    // exercising the projection. Tests that care override these.
    spyOn(AttachmentReferenceRepository, "deleteByMessageId").mockResolvedValue(0)
    spyOn(AttachmentReferenceRepository, "insertMany").mockResolvedValue(0)
  })

  afterEach(() => {
    mock.restore()
  })

  it("rejects an edit that references an E2E attachment (INV-E1 backstop, edit path)", async () => {
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "attach_e2e",
        workspaceId: "ws_1",
        streamId: "stream_e2e",
        messageId: "msg_e2e",
        safetyStatus: AttachmentSafetyStatuses.E2E_UNSCANNED,
        e2eOnly: true,
        filename: "encrypted",
        mimeType: "application/octet-stream",
        sizeBytes: 10,
      },
    ] as any)

    const service = new EventService({} as any)
    await expect(
      service.editMessageInternal({
        workspaceId: "ws_1",
        messageId: "msg_1",
        streamId: "stream_1",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "edited",
        actorId: "usr_1",
        attachmentIds: ["attach_e2e"],
      })
    ).rejects.toThrow("an E2E attachment can only be bound to a sealed message")
  })

  it("should snapshot pre-edit content as a version record", async () => {
    const service = new EventService({} as any)

    await service.editMessageInternal({
      workspaceId: "ws_1",
      messageId: "msg_1",
      streamId: "stream_1",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "edited" }] }] },
      contentMarkdown: "edited",
      actorId: "usr_1",
    })

    expect(MessageVersionRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "msg_1",
        versionNumber: 2,
        contentJson: existingMessage.contentJson,
        contentMarkdown: "original",
        editedBy: "usr_1",
      })
    )
  })

  it("should not create version when message does not exist", async () => {
    findByIdForUpdateSpy.mockResolvedValue(null)

    const service = new EventService({} as any)

    await service.editMessageInternal({
      workspaceId: "ws_1",
      messageId: "msg_nonexistent",
      streamId: "stream_1",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "edited",
      actorId: "usr_1",
    })

    expect(MessageVersionRepository.insert).not.toHaveBeenCalled()
  })

  it("resolves actor type as persona when not provided", async () => {
    isMemberSpy.mockResolvedValue(false)
    hasParticipatedSpy.mockResolvedValue(true)
    const service = new EventService({} as any)

    await service.editMessageInternal({
      workspaceId: "ws_1",
      messageId: "msg_1",
      streamId: "stream_1",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "edited" }] }] },
      contentMarkdown: "edited",
      actorId: "persona_1",
    })

    expect(StreamEventRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "persona",
      })
    )
  })

  it("throws when actor type cannot be resolved", async () => {
    isMemberSpy.mockResolvedValue(false)
    hasParticipatedSpy.mockResolvedValue(false)
    findByIdForUpdateSpy.mockResolvedValue({
      ...existingMessage,
      authorId: "another_actor",
    })
    const service = new EventService({} as any)

    await expect(
      service.editMessageInternal({
        workspaceId: "ws_1",
        messageId: "msg_1",
        streamId: "stream_1",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "edited",
        actorId: "unknown_actor",
      })
    ).rejects.toThrow("has no resolved type")

    expect(MessageVersionRepository.insert).not.toHaveBeenCalled()
  })

  it("uses existing message author type when actorType is omitted", async () => {
    isMemberSpy.mockResolvedValue(false)
    hasParticipatedSpy.mockResolvedValue(false)
    const service = new EventService({} as any)

    await service.editMessageInternal({
      workspaceId: "ws_1",
      messageId: "msg_1",
      streamId: "stream_1",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "edited",
      actorId: "usr_1",
    })

    expect(StreamEventRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "user",
      })
    )
  })
})

describe("EventService.editMessage attachment_references refresh", () => {
  // INV-7: edits that add or remove `attachment:` links must rewrite the
  // `attachment_references` projection in the same transaction. Without it,
  // download authorization stops matching the persisted body and copy-paste
  // resends fail. These tests pin the delete-then-insert behavior.
  const existingMessage = {
    id: "msg_edit",
    streamId: "stream_target",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "before edit",
    authorId: "usr_1",
    authorType: "user",
  }
  let deleteByMessageIdSpy: ReturnType<typeof spyOn>
  let insertManySpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(MessageRepository, "findByIdForUpdate").mockResolvedValue(existingMessage as any)
    spyOn(MessageRepository, "findById").mockResolvedValue(existingMessage as any)
    // editMessageInternal refuses edits in E2E streams at the sink (INV-E1).
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_target",
      type: "scratchpad",
      parentStreamId: null,
      parentMessageId: null,
    } as any)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    spyOn(StreamPersonaParticipantRepository, "hasParticipated").mockResolvedValue(false)
    spyOn(MessageVersionRepository, "insert").mockResolvedValue({} as any)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_edit",
      streamId: "stream_target",
      sequence: 2n,
      eventType: "message_edited",
      payload: {},
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(),
    } as any)
    spyOn(MessageRepository, "updateContent").mockResolvedValue({
      ...existingMessage,
      contentMarkdown: "after edit",
      editedAt: new Date(),
    } as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    deleteByMessageIdSpy = spyOn(AttachmentReferenceRepository, "deleteByMessageId").mockResolvedValue(0)
    insertManySpy = spyOn(AttachmentReferenceRepository, "insertMany").mockResolvedValue(0)
  })

  afterEach(() => {
    mock.restore()
  })

  it("clears existing attachment_references rows even when the new content has no attachments", async () => {
    // The "remove an attachment" case: the edited content drops a previously
    // referenced attachment. Without the delete the row stays and recipients
    // can still resolve a download for content that no longer cites it.
    const service = new EventService({} as any)
    await service.editMessageInternal({
      workspaceId: "ws_1",
      messageId: "msg_edit",
      streamId: "stream_target",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "after edit",
      actorId: "usr_1",
      // No attachmentIds passed — the edit removed the reference.
    })

    expect(deleteByMessageIdSpy).toHaveBeenCalledTimes(1)
    expect(deleteByMessageIdSpy.mock.calls[0]?.[1]).toBe("ws_1")
    expect(deleteByMessageIdSpy.mock.calls[0]?.[2]).toBe("msg_edit")
    // Nothing to re-insert.
    expect(insertManySpy).not.toHaveBeenCalled()
  })

  it("rewrites attachment_references rows when the new content adds an attachment ref", async () => {
    // The "add an attachment" case: an edit gains an `attachment:` link, so
    // a fresh row must be inserted for download authorization to match.
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "att_a",
        workspaceId: "ws_1",
        streamId: "stream_source",
        messageId: "msg_source",
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        filename: "img.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
    ] as any)

    const service = new EventService({} as any)
    await service.editMessageInternal({
      workspaceId: "ws_1",
      messageId: "msg_edit",
      streamId: "stream_target",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "now with image",
      actorId: "usr_1",
      attachmentIds: ["att_a"],
      // Persona-flavor scope so the set-membership gate accepts stream_source.
      accessibleStreamIds: ["stream_target", "stream_source"],
    })

    expect(deleteByMessageIdSpy).toHaveBeenCalledTimes(1)
    expect(insertManySpy).toHaveBeenCalledTimes(1)
    const inserted = insertManySpy.mock.calls[0]?.[1] as Array<{ attachmentId: string; messageId: string }>
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ attachmentId: "att_a", messageId: "msg_edit" })
  })

  it("rejects fresh-upload attachment ids on edit (messageId === null)", async () => {
    // Edits cannot claim ownership of a fresh upload — that's a create-time
    // operation. Throw loudly so we don't orphan the upload or leave the
    // attachment row in an inconsistent state.
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
      {
        id: "att_fresh",
        workspaceId: "ws_1",
        streamId: null,
        messageId: null,
        safetyStatus: AttachmentSafetyStatuses.CLEAN,
        filename: "fresh.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
    ] as any)

    const service = new EventService({} as any)
    await expect(
      service.editMessageInternal({
        workspaceId: "ws_1",
        messageId: "msg_edit",
        streamId: "stream_target",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "trying to attach",
        actorId: "usr_1",
        attachmentIds: ["att_fresh"],
      })
    ).rejects.toThrow("edits cannot attach fresh uploads")
  })
})

describe("EventService.createMessage metadata propagation", () => {
  const baseParams = {
    workspaceId: "ws_1",
    streamId: "stream_1",
    authorId: "usr_1",
    authorType: "user" as const,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
  }

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", type: "scratchpad" } as any)
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(AttachmentRepository, "attachToMessage").mockResolvedValue(0)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 1n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: params.clientMessageId ?? null,
      sentVia: params.sentVia ?? null,
      reactions: {},
      metadata: params.metadata ?? {},
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "findById").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(messagesTotal, "inc").mockImplementation(() => undefined)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(SharedMessageRepository, "insert").mockResolvedValue({} as any)
  })

  afterEach(() => {
    mock.restore()
  })

  it("propagates non-empty metadata to the event payload and the projection", async () => {
    const service = new EventService({} as any)
    const metadata = { "github.pr.id": "42", "github.event": "review_requested" }

    await service.createMessage({ ...baseParams, metadata })

    expect(StreamEventRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "message_created",
        payload: expect.objectContaining({ metadata }),
      })
    )
    expect(MessageRepository.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ metadata }))
  })

  it("omits metadata from the event payload and projection when unset or empty", async () => {
    const service = new EventService({} as any)

    await service.createMessage({ ...baseParams, metadata: {} })

    const eventPayload = (StreamEventRepository.insert as any).mock.calls[0][1].payload
    expect(eventPayload).not.toHaveProperty("metadata")

    const insertParams = (MessageRepository.insert as any).mock.calls[0][1]
    expect(insertParams.metadata).toBeUndefined()
  })

  it("runs the transactional callback for a newly created message", async () => {
    const service = new EventService({} as any)
    const onCreated = mock(async () => undefined)

    await service.createMessageReturningConversationInternal(baseParams, onCreated)

    expect(onCreated).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contentMarkdown: "hello" }))
  })

  it("does not repeat the transactional callback for an idempotent message retry", async () => {
    const service = new EventService({} as any)
    const existing = {
      id: "msg_existing",
      streamId: "stream_1",
      contentMarkdown: "hello",
      ciphertext: null,
    }
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(existing as any)
    const onCreated = mock(async () => undefined)

    const result = await service.createMessageReturningConversationInternal(
      { ...baseParams, clientMessageId: "temp_1" },
      onCreated
    )

    expect(result.message.id).toBe("msg_existing")
    expect(onCreated).not.toHaveBeenCalled()
  })
})

describe("EventService.createMessage author born-read", () => {
  const baseParams = {
    workspaceId: "ws_1",
    streamId: "stream_1",
    authorId: "usr_1",
    authorType: "user" as const,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
  }

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", type: "scratchpad" } as any)
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(AttachmentRepository, "attachToMessage").mockResolvedValue(0)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 1n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: params.clientMessageId ?? null,
      sentVia: params.sentVia ?? null,
      reactions: {},
      metadata: params.metadata ?? {},
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "findById").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(messagesTotal, "inc").mockImplementation(() => undefined)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(SharedMessageRepository, "insert").mockResolvedValue({} as any)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
  })

  afterEach(() => {
    mock.restore()
  })

  it("advances the author's read state on the same tx client", async () => {
    const service = new EventService({} as any)

    await service.createMessage(baseParams)

    // The born-read lands in stream_read_state on the same tx client with the
    // same (stream, author, event) — the author's own message isn't counted unread.
    const createdEventId = (StreamEventRepository.insert as any).mock.calls[0][1].id
    expect(ReadStateRepository.advance).toHaveBeenCalledWith({}, "stream_1", "usr_1", createdEventId)
  })

  it("born-reads a non-member author too — read state is user-anchored, not membership-gated", async () => {
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)
    const service = new EventService({} as any)

    await service.createMessage(baseParams)

    const createdEventId = (StreamEventRepository.insert as any).mock.calls[0][1].id
    expect(ReadStateRepository.advance).toHaveBeenCalledWith({}, "stream_1", "usr_1", createdEventId)
  })
})

describe("EventService.createMessage conversation declaration (Mechanism C)", () => {
  const baseParams = {
    workspaceId: "ws_1",
    streamId: "stream_1",
    authorId: "usr_1",
    authorType: "user" as const,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
  }

  const assignInTransaction = mock(async () => "conv_assigned")
  const attachProvisionalInTransaction = mock(async (): Promise<string | null> => null)
  const conversationAssigner = { assignInTransaction, attachProvisionalInTransaction }

  beforeEach(() => {
    assignInTransaction.mockClear()
    attachProvisionalInTransaction.mockClear()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({} as never)
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", type: "scratchpad" } as any)
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(AttachmentRepository, "attachToMessage").mockResolvedValue(0)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 1n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: params.clientMessageId ?? null,
      sentVia: params.sentVia ?? null,
      reactions: {},
      metadata: params.metadata ?? {},
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "findById").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(messagesTotal, "inc").mockImplementation(() => undefined)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(SharedMessageRepository, "insert").mockResolvedValue({} as any)
  })

  afterEach(() => {
    mock.restore()
  })

  it("stamps declaredConversationId on the payload for an existing-conversation directive and runs the assigner", async () => {
    const service = new EventService({} as any, conversationAssigner)

    await service.createMessage({
      ...baseParams,
      conversation: { intent: ConversationIntents.EXISTING, conversationId: "conv_abc" },
    })

    expect(StreamEventRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "message_created",
        payload: expect.objectContaining({ declaredConversationId: "conv_abc" }),
      })
    )
    expect(assignInTransaction).toHaveBeenCalled()
  })

  it("passes the initiating human to a declared conversation assignment", async () => {
    const service = new EventService({} as any, conversationAssigner)

    await service.createMessageForPrincipalReturningConversation(
      { kind: "user", userId: "usr_operator" },
      { ...baseParams, conversation: { intent: ConversationIntents.NEW } }
    )

    expect(assignInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ initiatingUserId: "usr_operator" })
    )
  })

  it("omits declaredConversationId for a new-conversation directive — a fresh topic is a chip-less opener", async () => {
    const service = new EventService({} as any, conversationAssigner)

    await service.createMessage({ ...baseParams, conversation: { intent: ConversationIntents.NEW } })

    const eventPayload = (StreamEventRepository.insert as any).mock.calls[0][1].payload
    expect(eventPayload).not.toHaveProperty("declaredConversationId")
    expect(assignInTransaction).toHaveBeenCalled()
  })

  it("omits declaredConversationId and takes the provisional path when the send declares no conversation", async () => {
    const service = new EventService({} as any, conversationAssigner)

    await service.createMessage({ ...baseParams })

    const eventPayload = (StreamEventRepository.insert as any).mock.calls[0][1].payload
    expect(eventPayload).not.toHaveProperty("declaredConversationId")
    expect(assignInTransaction).not.toHaveBeenCalled()
    expect(attachProvisionalInTransaction).toHaveBeenCalled()
  })

  it("surfaces the assigner's conversation id from createMessageReturningConversation for an optimistic board card", async () => {
    const service = new EventService({} as any, conversationAssigner)

    const declared = await service.createMessageReturningConversationInternal({
      ...baseParams,
      conversation: { intent: ConversationIntents.NEW },
    })
    expect(declared.conversationId).toBe("conv_assigned")

    const undeclared = await service.createMessageReturningConversationInternal({ ...baseParams })
    expect(undeclared.conversationId).toBeUndefined()
  })
})

describe("EventService INV-E1 sink guard", () => {
  const baseParams = {
    workspaceId: "ws_1",
    streamId: "stream_1",
    authorId: "usr_1",
    authorType: "user" as const,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
  }

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)
  })

  afterEach(() => {
    mock.restore()
  })

  it("rejects a plaintext create into an E2E stream (E2E_STREAM_REQUIRES_CIPHERTEXT)", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", e2eEnabled: true } as any)
    const insert = spyOn(StreamEventRepository, "insert")
    const service = new EventService({} as any)

    await expect(service.createMessage(baseParams)).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_REQUIRES_CIPHERTEXT",
    })
    // The guard fires before any write — no orphaned event row.
    expect(insert).not.toHaveBeenCalled()
  })

  it("rejects a half-formed sealed create (ciphertext, no envelope/e2eVersion) into an E2E stream", async () => {
    // A ciphertext row with no envelope is undecryptable — the sink must require
    // the full E2E triple, not just the presence of ciphertext.
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", e2eEnabled: true } as any)
    const insert = spyOn(StreamEventRepository, "insert")
    const service = new EventService({} as any)

    await expect(service.createMessage({ ...baseParams, ciphertext: Buffer.from("opaque") })).rejects.toMatchObject({
      status: 400,
      code: "E2E_STREAM_REQUIRES_CIPHERTEXT",
    })
    expect(insert).not.toHaveBeenCalled()
  })

  it("rejects a ciphertext create into a non-E2E stream (E2E_PAYLOAD_REQUIRES_E2E_STREAM)", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue({ id: "stream_1", e2eEnabled: false } as any)
    const insert = spyOn(StreamEventRepository, "insert")
    const service = new EventService({} as any)

    await expect(
      service.createMessage({
        ...baseParams,
        ciphertext: Buffer.from("opaque"),
        envelope: { v: 2, keyGeneration: 0, iv: "AAAA", aad: "AAAA" },
        e2eVersion: 2,
      })
    ).rejects.toMatchObject({ status: 400, code: "E2E_PAYLOAD_REQUIRES_E2E_STREAM" })
    expect(insert).not.toHaveBeenCalled()
  })

  it("refuses to edit a message in an E2E stream (E2E_STREAM_EDIT_UNSUPPORTED)", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const findForUpdate = spyOn(MessageRepository, "findByIdForUpdate")
    const service = new EventService({} as any)

    await expect(
      service.editMessageInternal({
        workspaceId: "ws_1",
        messageId: "msg_1",
        streamId: "stream_1",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "edited",
        actorId: "usr_1",
      })
    ).rejects.toMatchObject({ status: 400, code: "E2E_STREAM_EDIT_UNSUPPORTED" })
    // Refused before loading or mutating the message.
    expect(findForUpdate).not.toHaveBeenCalled()
  })
})

describe("EventService.listEventsAroundDate", () => {
  beforeEach(() => {
    spyOn(db, "withClient").mockImplementation(((_pool: unknown, cb: (client: any) => Promise<unknown>) =>
      cb({})) as any)
  })

  afterEach(() => {
    mock.restore()
  })

  it("returns an empty window with a null anchor when no message lands on or after the date", async () => {
    spyOn(StreamEventRepository, "findFirstMessageOnOrAfter").mockResolvedValue(null)
    const listAround = spyOn(StreamEventRepository, "listAround")

    const service = new EventService({} as any)
    const result = await service.listEventsAroundDate("stream_1", new Date("2026-06-16T00:00:00.000Z"))

    expect(result).toEqual({ events: [], hasOlder: false, hasNewer: false, anchorMessageId: null })
    expect(listAround).not.toHaveBeenCalled()
  })

  it("centers the window on the first message and returns its messageId as the anchor", async () => {
    const anchor: StreamEvent = {
      id: "evt_anchor",
      streamId: "stream_1",
      sequence: 42n,
      broadcastSequence: 10n,
      eventType: "message_created",
      payload: { messageId: "msg_anchor" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date("2026-06-16T09:00:00.000Z"),
    }
    spyOn(StreamEventRepository, "findFirstMessageOnOrAfter").mockResolvedValue(anchor)
    const around = { events: [anchor], hasOlder: true, hasNewer: true }
    const listAround = spyOn(StreamEventRepository, "listAround").mockResolvedValue(around)

    const service = new EventService({} as any)
    const result = await service.listEventsAroundDate("stream_1", new Date("2026-06-16T00:00:00.000Z"), {
      limit: 20,
      viewerId: "usr_1",
    })

    expect(listAround).toHaveBeenCalledWith(expect.anything(), "stream_1", 42n, { limit: 20, viewerId: "usr_1" })
    expect(result).toEqual({ ...around, anchorMessageId: "msg_anchor" })
  })
})

describe("EventService.createMessage parent thread update (reply in thread)", () => {
  const baseParams = {
    workspaceId: "ws_1",
    streamId: "stream_thread",
    authorId: "usr_1",
    authorType: "user" as const,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "a reply",
  }

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_thread",
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_root",
      parentAnchorId: "msg_parent",
    } as any)
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(AttachmentRepository, "attachToMessage").mockResolvedValue(0)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 1n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: null,
      sentVia: null,
      reactions: {},
      metadata: {},
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "findById").mockResolvedValue({ id: "msg_parent", replyCount: 4 } as any)
    spyOn(StreamRepository, "findThreadSummaryByParentMessage").mockResolvedValue(null)
    spyOn(StreamRepository, "bumpThreadReplyCount").mockResolvedValue({
      id: "stream_thread",
      workspaceId: "ws_1",
      parentStreamId: "stream_root",
      parentAnchorId: "msg_parent",
      replyCount: 5,
    } as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(messagesTotal, "inc").mockImplementation(() => undefined)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(SharedMessageRepository, "insert").mockResolvedValue({} as any)
  })

  afterEach(() => {
    mock.restore()
  })

  it("increments the thread stream's reply_count and emits thread:updated for a msg_ anchor", async () => {
    const service = new EventService({} as any)

    await service.createMessage(baseParams)

    // Reply-count maintenance lives on the thread stream row (INV-20 atomic +1).
    expect(StreamRepository.bumpThreadReplyCount).toHaveBeenCalledWith(expect.anything(), "stream_thread", 1)
    // Anchor-agnostic patch, replyCount read off the thread stream row.
    expect(OutboxRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      "thread:updated",
      expect.objectContaining({
        parentStreamId: "stream_root",
        anchorId: "msg_parent",
        threadId: "stream_thread",
        replyCount: 5,
        threadSummary: null,
      })
    )
    // The legacy message:updated reply_count patch is gone — thread:updated is
    // the sole projection for every anchor kind.
    const emitted = (OutboxRepository.insert as any).mock.calls.map((c: unknown[]) => c[1])
    expect(emitted).toContain("thread:updated")
    expect(emitted).not.toContain("message:updated")
  })

  it("event-anchored thread reply emits thread:updated with the event-id anchor and NO legacy message:updated", async () => {
    // A thread hung under a card: anchor is an event_ id, no parent message.
    ;(StreamRepository.findById as any).mockResolvedValue({
      id: "stream_thread",
      type: "thread",
      parentStreamId: "stream_root",
      parentAnchorId: "event_card1",
    })
    ;(StreamRepository.bumpThreadReplyCount as any).mockResolvedValue({
      id: "stream_thread",
      workspaceId: "ws_1",
      parentStreamId: "stream_root",
      parentAnchorId: "event_card1",
      replyCount: 1,
    })

    const service = new EventService({} as any)
    await service.createMessage(baseParams)

    expect(OutboxRepository.insert).toHaveBeenCalledWith(
      expect.anything(),
      "thread:updated",
      expect.objectContaining({
        parentStreamId: "stream_root",
        anchorId: "event_card1",
        threadId: "stream_thread",
        replyCount: 1,
      })
    )
    // No legacy patch for a card anchor.
    const emitted = (OutboxRepository.insert as any).mock.calls.map((c: unknown[]) => c[1])
    expect(emitted).not.toContain("message:updated")
  })
})

describe("EventService sharedMessages wire enrichment", () => {
  const shareNode = { type: "sharedMessage", attrs: { messageId: "msg_source", streamId: "stream_source" } }
  const hydratedEntry = {
    type: "sharedMessage",
    state: "ok",
    messageId: "msg_source",
    streamId: "stream_source",
  }

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(messagesTotal, "inc").mockImplementation(() => undefined)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    // Target stream (create-path E2E check, post-write thread lookup) vs.
    // source stream (share validation's findStream / checkStreamAccess).
    spyOn(StreamRepository, "findById").mockImplementation((async (_client: any, id: string) => {
      if (id === "stream_source") {
        return {
          id: "stream_source",
          workspaceId: "ws_1",
          type: "channel",
          visibility: "public",
          rootStreamId: null,
        }
      }
      return { id: "stream_1", workspaceId: "ws_1", type: "scratchpad", parentStreamId: null, parentAnchorId: null }
    }) as any)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 1n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: null,
      sentVia: null,
      reactions: {},
      metadata: {},
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    })) as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    // Share validation runs over mocked repos (house style — the service
    // itself is not stubbed).
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(SharedMessageRepository, "insert").mockResolvedValue({} as any)
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([["msg_source", { id: "msg_source", streamId: "stream_source" }]]) as any
    )
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(StreamRepository, "isAncestor").mockResolvedValue(false)
    // Hydration itself is covered in sharing/hydration.test.ts — stub the
    // wire entry and assert what rides the outbox payload.
    spyOn(sharing, "hydrateSharedMessagesForRoom").mockResolvedValue({ msg_source: hydratedEntry } as any)
    // Edit-path plumbing.
    spyOn(MessageRepository, "findByIdForUpdate").mockResolvedValue({
      id: "msg_1",
      streamId: "stream_1",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "original",
      authorId: "usr_1",
      authorType: "user",
    } as any)
    spyOn(MessageRepository, "updateContent").mockResolvedValue({ id: "msg_1", editedAt: new Date() } as any)
    spyOn(MessageVersionRepository, "insert").mockResolvedValue({} as any)
    spyOn(AttachmentReferenceRepository, "deleteByMessageId").mockResolvedValue(0)
    spyOn(AttachmentReferenceRepository, "insertMany").mockResolvedValue(0)
  })

  afterEach(() => {
    mock.restore()
  })

  it("carries the hydrated sharedMessages map on the message:created outbox payload", async () => {
    const service = new EventService({} as any)
    await service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: "user",
      contentJson: { type: "doc", content: [shareNode] },
      contentMarkdown: "look at this",
    })

    const created = (OutboxRepository.insert as any).mock.calls.find((c: unknown[]) => c[1] === "message:created")
    // Dual-publish: the same hydration value rides both the canonical
    // namespaced map and the temporary legacy bare-key map.
    expect(created?.[2].sharedMessages).toEqual({ msg_source: hydratedEntry })
    expect(created?.[2].slots).toEqual({ [sharedMessageSlotKey("msg_source")]: hydratedEntry })
  })

  it("omits sharedMessages from the message:created payload for pointer-free content", async () => {
    const service = new EventService({} as any)
    await service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: "user",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "plain" }] }] },
      contentMarkdown: "plain",
    })

    const created = (OutboxRepository.insert as any).mock.calls.find((c: unknown[]) => c[1] === "message:created")
    expect(created?.[2]).not.toHaveProperty("sharedMessages")
    expect(created?.[2]).not.toHaveProperty("slots")
    // Cost guard: pointer-free content pays only the content pre-scan.
    expect(sharing.hydrateSharedMessagesForRoom).not.toHaveBeenCalled()
  })

  it("carries the hydrated sharedMessages map on the message:edited outbox payload when an edit adds a pointer", async () => {
    const service = new EventService({} as any)
    await service.editMessageInternal({
      workspaceId: "ws_1",
      messageId: "msg_1",
      streamId: "stream_1",
      contentJson: { type: "doc", content: [shareNode] },
      contentMarkdown: "now with a share",
      actorId: "usr_1",
    })

    const edited = (OutboxRepository.insert as any).mock.calls.find((c: unknown[]) => c[1] === "message:edited")
    expect(edited?.[2].sharedMessages).toEqual({ msg_source: hydratedEntry })
    expect(edited?.[2].slots).toEqual({ [sharedMessageSlotKey("msg_source")]: hydratedEntry })
  })
})

describe("EventService.moveMessagesToThread destination slot carrier (B3)", () => {
  const shareNode = { type: "sharedMessage", attrs: { messageId: "msg_source", streamId: "stream_source" } }
  const hydratedEntry = {
    type: "sharedMessage",
    state: "ok",
    messageId: "msg_source",
    streamId: "stream_source",
  }
  const sourceStream = {
    id: "stream_src",
    workspaceId: "ws_1",
    type: "channel",
    visibility: "public",
    slug: "src",
    displayName: null,
    archivedAt: null,
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
  }
  const destinationThread = {
    id: "stream_thread",
    workspaceId: "ws_1",
    type: "thread",
    visibility: "public",
    slug: "thread",
    displayName: null,
    archivedAt: null,
    parentStreamId: "stream_src",
    parentAnchorId: "msg_target",
    rootStreamId: "stream_src",
  }

  function movedMessage(contentJson: unknown) {
    return {
      id: "msg_a",
      streamId: "stream_src",
      sequence: 2n,
      deletedAt: null,
      authorId: "usr_3",
      authorType: "user",
      contentJson,
      contentMarkdown: "look at this",
      createdAt: new Date(),
    }
  }

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(OperationLeaseRepository, "consume").mockResolvedValue({
      payload: { sourceStreamId: "stream_src", targetMessageId: "msg_target", messageIds: ["msg_a"] },
    } as any)
    spyOn(StreamRepository, "findById").mockResolvedValue(sourceStream as any)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    spyOn(MessageRepository, "findByIdForUpdate").mockResolvedValue({
      id: "msg_target",
      streamId: "stream_src",
      sequence: 1n,
      deletedAt: null,
      authorId: "usr_2",
      authorType: "user",
      contentMarkdown: "**anchor** message",
      createdAt: new Date("2026-07-01T08:00:00.000Z"),
    } as any)
    spyOn(MessageRepository, "findByIdsForUpdate").mockResolvedValue([
      movedMessage({ type: "doc", content: [shareNode] }),
    ] as any)
    spyOn(StreamRepository, "insertThreadOrFind").mockResolvedValue({
      stream: destinationThread,
      created: true,
    } as any)
    spyOn(StreamMemberRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(StreamEventRepository, "findMessageCreatedByMessageIdsForUpdate").mockResolvedValue([
      {
        id: "evt_a",
        streamId: "stream_src",
        sequence: 2n,
        broadcastSequence: 2n,
        eventType: "message_created",
        payload: { messageId: "msg_a", contentJson: { type: "doc", content: [shareNode] } },
        actorId: "usr_3",
        actorType: "user",
        createdAt: new Date(),
      },
    ] as any)
    spyOn(MessageRepository, "findAgentSessionIdsForMessages").mockResolvedValue([])
    spyOn(StreamEventRepository, "findAgentSessionEventsBySessionIdsForUpdate").mockResolvedValue([])
    spyOn(StreamEventRepository, "getNextSequencePairs").mockResolvedValue([{ sequence: 10n, broadcastSequence: 10n }])
    spyOn(StreamEventRepository, "moveMessageCreatedEvents").mockResolvedValue([
      {
        id: "evt_a",
        streamId: "stream_thread",
        sequence: 10n,
        broadcastSequence: 10n,
        eventType: "message_created",
        payload: { messageId: "msg_a", contentJson: { type: "doc", content: [shareNode] } },
        actorId: "usr_3",
        actorType: "user",
        createdAt: new Date(),
      },
    ] as any)
    spyOn(StreamEventRepository, "moveEventsById").mockResolvedValue([])
    spyOn(MessageRepository, "moveToStream").mockResolvedValue(undefined as any)
    spyOn(SparseReadRepository, "rehomeReads").mockResolvedValue(undefined as any)
    spyOn(ReadStateRepository, "repointForMovedEvents").mockResolvedValue(undefined as any)
    spyOn(DraftsRepository, "rescopeByScope").mockResolvedValue([])
    spyOn(MessageRepository, "updateStreamScopedReferences").mockResolvedValue(undefined as any)
    spyOn(StreamRepository, "moveChildThreadsToParent").mockResolvedValue(undefined as any)
    spyOn(StreamRepository, "bumpThreadReplyCount").mockResolvedValue({ ...destinationThread, replyCount: 1 } as any)
    spyOn(StreamRepository, "findThreadSummaryByParentMessage").mockResolvedValue(null)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: `evt_tombstone_${params.streamId}`,
      streamId: params.streamId,
      sequence: 11n,
      broadcastSequence: 11n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt: new Date(),
    })) as any)
    spyOn(StreamEventRepository, "countMessagesByStreamBatch").mockResolvedValue(new Map([["stream_src", 5]]))
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    // Hydration itself is covered in sharing/hydration.test.ts — stub the wire
    // entry and assert what rides the outbox payload.
    spyOn(sharing, "hydrateSharedMessagesForRoom").mockResolvedValue({ msg_source: hydratedEntry } as any)
  })

  afterEach(() => {
    mock.restore()
  })

  it("attaches the dual destination slot map to the messages:moved outbox payload", async () => {
    const service = new EventService({} as any)
    await service.moveMessagesToThreadInternal({
      workspaceId: "ws_1",
      sourceStreamId: "stream_src",
      targetMessageId: "msg_target",
      messageIds: ["msg_a"],
      actorId: "usr_1",
      leaseKey: "lease_1",
    })

    // One room-uniform hydration for the DESTINATION thread over the moved
    // messages' share refs.
    expect(sharing.hydrateSharedMessagesForRoom).toHaveBeenCalledWith(
      {},
      "ws_1",
      "stream_thread",
      new Set(["msg_source"])
    )
    const moved = (OutboxRepository.insert as any).mock.calls.find((c: unknown[]) => c[1] === "messages:moved")
    expect(moved?.[2].slots).toEqual({ [sharedMessageSlotKey("msg_source")]: hydratedEntry })
    expect(moved?.[2].sharedMessages).toEqual({ msg_source: hydratedEntry })

    // A3: the moved events' source read frontiers are repointed on the same tx
    // client (same source stream, event+source-sequence pairs).
    expect(ReadStateRepository.repointForMovedEvents).toHaveBeenCalledWith({}, "stream_src", expect.any(Array))
  })

  it("re-homes the moved messages' context rows onto the destination thread", async () => {
    const service = new EventService({} as any)
    await service.moveMessagesToThreadInternal({
      workspaceId: "ws_1",
      sourceStreamId: "stream_src",
      targetMessageId: "msg_target",
      messageIds: ["msg_a"],
      actorId: "usr_1",
      leaseKey: "lease_1",
    })

    expect(StreamContextRepository.reparentMessages).toHaveBeenCalledWith(
      {},
      "ws_1",
      [{ messageId: "msg_a", sequence: 10n }],
      "stream_thread",
      "stream_src"
    )
  })

  it("writes the thread landmark for a thread the move just created", async () => {
    const service = new EventService({} as any)
    await service.moveMessagesToThreadInternal({
      workspaceId: "ws_1",
      sourceStreamId: "stream_src",
      targetMessageId: "msg_target",
      messageIds: ["msg_a"],
      actorId: "usr_1",
      leaseKey: "lease_1",
    })

    const rows = (StreamContextRepository.insertMany as any).mock.calls[0][1]
    expect(rows.map(({ id, ...rest }: Record<string, unknown>) => rest)).toEqual([
      {
        workspaceId: "ws_1",
        streamId: "stream_src",
        rootStreamId: "stream_src",
        category: "thread",
        refKind: "thread",
        refId: "stream_thread",
        groupKey: "stream_thread",
        sourceMessageId: "msg_target",
        authorId: "usr_2",
        occurredAt: new Date("2026-07-01T08:00:00.000Z"),
        sequence: 1n,
        snippet: "anchor message",
        detail: {},
      },
    ])
  })

  it("writes no landmark when the move lands in an existing thread", async () => {
    ;(StreamRepository.insertThreadOrFind as any).mockResolvedValue({ stream: destinationThread, created: false })

    const service = new EventService({} as any)
    await service.moveMessagesToThreadInternal({
      workspaceId: "ws_1",
      sourceStreamId: "stream_src",
      targetMessageId: "msg_target",
      messageIds: ["msg_a"],
      actorId: "usr_1",
      leaseKey: "lease_1",
    })

    expect(StreamContextRepository.insertMany).not.toHaveBeenCalled()
  })

  it("omits both maps and skips hydration for a pointer-free move", async () => {
    ;(MessageRepository.findByIdsForUpdate as any).mockResolvedValue([
      movedMessage({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "plain" }] }] }),
    ])

    const service = new EventService({} as any)
    await service.moveMessagesToThreadInternal({
      workspaceId: "ws_1",
      sourceStreamId: "stream_src",
      targetMessageId: "msg_target",
      messageIds: ["msg_a"],
      actorId: "usr_1",
      leaseKey: "lease_1",
    })

    expect(sharing.hydrateSharedMessagesForRoom).not.toHaveBeenCalled()
    const moved = (OutboxRepository.insert as any).mock.calls.find((c: unknown[]) => c[1] === "messages:moved")
    expect(moved?.[2]).not.toHaveProperty("slots")
    expect(moved?.[2]).not.toHaveProperty("sharedMessages")
  })
})

describe("EventService stream-context projection", () => {
  const linkContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] }],
      },
    ],
  }

  function stubCreatePath(stream: Record<string, unknown>) {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(StreamRepository, "findById").mockResolvedValue(stream as any)
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_1",
      streamId: "stream_1",
      sequence: 11n,
      eventType: "message_created",
      payload: {},
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
    } as any)
    // Deliberately EARLIER than the event's created_at: the landmark must come
    // from the message row (transaction start), not the app-clock event stamp.
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      ...params,
      createdAt: new Date("2026-07-20T09:59:59.500Z"),
    })) as any)
    spyOn(MessageRepository, "findById").mockResolvedValue(null)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(messagesTotal, "inc").mockImplementation(() => undefined)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
  }

  afterEach(() => {
    mock.restore()
  })

  it("indexes a created message's artifacts at the MESSAGE's created_at", async () => {
    stubCreatePath({ id: "stream_1", type: "thread", rootStreamId: "stream_root" })
    const service = new EventService({} as any)

    await service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: "user",
      contentJson: linkContent,
      contentMarkdown: "see https://example.com/a",
    })

    const rows = (StreamContextRepository.insertMany as any).mock.calls[0][1]
    expect(rows.map(({ id, ...rest }: Record<string, unknown>) => rest)).toEqual([
      {
        workspaceId: "ws_1",
        streamId: "stream_1",
        rootStreamId: "stream_root",
        category: "link",
        refKind: "url",
        refId: "https://example.com/a",
        groupKey: "https://example.com/a",
        sourceMessageId: expect.stringContaining("msg_"),
        authorId: "usr_1",
        occurredAt: new Date("2026-07-20T09:59:59.500Z"),
        sequence: 11n,
        snippet: "see https://example.com/a",
        detail: { url: "https://example.com/a" },
      },
    ])
  })

  it("writes nothing for a sealed stream", async () => {
    stubCreatePath({ id: "stream_1", type: "scratchpad", rootStreamId: null, e2eEnabled: true })
    const service = new EventService({} as any)

    await service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: "user",
      contentJson: linkContent,
      contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
      ciphertext: Buffer.from("sealed"),
      envelope: { v: 1 } as any,
      e2eVersion: 1,
    })

    expect(StreamContextRepository.insertMany).not.toHaveBeenCalled()
  })

  it("rebuilds an edited message's rows without moving the landmark", async () => {
    const existingMessage = {
      id: "msg_edit",
      streamId: "stream_1",
      sequence: 4n,
      authorId: "usr_1",
      authorType: "user",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "before edit",
      createdAt: new Date("2026-07-01T09:00:00.000Z"),
    }
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(MessageRepository, "findByIdForUpdate").mockResolvedValue(existingMessage as any)
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      type: "channel",
      rootStreamId: null,
      parentStreamId: null,
    } as any)
    spyOn(MessageVersionRepository, "insert").mockResolvedValue({} as any)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_edit",
      streamId: "stream_1",
      sequence: 12n,
      eventType: "message_edited",
      payload: {},
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
    } as any)
    spyOn(MessageRepository, "updateContent").mockResolvedValue({ ...existingMessage } as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(AttachmentReferenceRepository, "deleteByMessageId").mockResolvedValue(0)

    const service = new EventService({} as any)
    await service.editMessageInternal({
      workspaceId: "ws_1",
      messageId: "msg_edit",
      streamId: "stream_1",
      contentJson: linkContent,
      contentMarkdown: "see https://example.com/a",
      actorId: "usr_1",
      actorType: "user",
    })

    const [, workspaceId, messageId, rows] = (StreamContextRepository.replaceForMessage as any).mock.calls[0]
    expect({ workspaceId, messageId, rows: rows.map(({ id, ...rest }: Record<string, unknown>) => rest) }).toEqual({
      workspaceId: "ws_1",
      messageId: "msg_edit",
      rows: [
        {
          workspaceId: "ws_1",
          streamId: "stream_1",
          rootStreamId: "stream_1",
          category: "link",
          refKind: "url",
          refId: "https://example.com/a",
          groupKey: "https://example.com/a",
          sourceMessageId: "msg_edit",
          authorId: "usr_1",
          occurredAt: new Date("2026-07-01T09:00:00.000Z"),
          sequence: 4n,
          snippet: "see https://example.com/a",
          detail: { url: "https://example.com/a" },
        },
      ],
    })
  })

  it("drops a deleted message's rows", async () => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) => {
      const client = { query: async () => ({ rows: [], rowCount: 0 }) }
      return callback(client)
    }) as any)
    spyOn(MessageRepository, "findByIdForUpdate").mockResolvedValue({
      id: "msg_del",
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: "user",
      deletedAt: null,
    } as any)
    spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "evt_del" } as any)
    spyOn(MessageRepository, "softDelete").mockResolvedValue(null as any)

    const service = new EventService({} as any)
    await service.deleteMessageInternal({
      workspaceId: "ws_1",
      streamId: "stream_1",
      messageId: "msg_del",
      actorId: "usr_1",
      actorType: "user",
    })

    expect(StreamContextRepository.deleteByMessageId).toHaveBeenCalledWith(expect.anything(), "ws_1", "msg_del")
  })
})

describe("EventService.createMessage outbox pairing (the sidebar's single preview writer)", () => {
  const createdAt = new Date("2026-08-04T10:00:00.000Z")

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    spyOn(messagesTotal, "inc").mockImplementation(() => undefined)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(7)
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "scratchpad",
      parentStreamId: null,
      parentAnchorId: null,
    } as any)
    spyOn(StreamEventRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: "evt_1",
      streamId: params.streamId,
      sequence: 42n,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
      createdAt,
    })) as any)
    spyOn(MessageRepository, "insert").mockImplementation((async (_client: any, params: any) => ({
      id: params.id,
      streamId: params.streamId,
      sequence: params.sequence,
      authorId: params.authorId,
      authorType: params.authorType,
      contentJson: params.contentJson,
      contentMarkdown: params.contentMarkdown,
      replyCount: 0,
      clientMessageId: null,
      sentVia: null,
      reactions: {},
      metadata: {},
      editedAt: null,
      deletedAt: null,
      createdAt,
    })) as any)
    spyOn(MessageRepository, "findByClientMessageId").mockResolvedValue(null)
    spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined as any)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
  })

  afterEach(() => {
    mock.restore()
  })

  it("createMessage emits stream:activity alongside message:created", async () => {
    const service = new EventService({} as any)
    await service.createMessage({
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: "user",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      contentMarkdown: "hello",
    })

    const calls = (OutboxRepository.insert as any).mock.calls as unknown[][]
    const created = calls.find((call) => call[1] === "message:created")
    const activity = calls.find((call) => call[1] === "stream:activity")

    // The sidebar preview is written from `stream:activity` alone, so this
    // pairing — and the markdown it carries — is load-bearing.
    expect({
      createdEventId: (created?.[2] as any)?.event?.id,
      createdStreamId: (created?.[2] as any)?.streamId,
      activity: activity?.[2],
      activityFollowsCreated: calls.indexOf(activity!) > calls.indexOf(created!),
    }).toEqual({
      createdEventId: "evt_1",
      createdStreamId: "stream_1",
      activity: {
        workspaceId: "ws_1",
        streamId: "stream_1",
        authorId: "usr_1",
        sequence: "42",
        messageOrdinal: 7,
        lastMessagePreview: {
          authorId: "usr_1",
          authorType: "user",
          content: "hello",
          createdAt: createdAt.toISOString(),
        },
      },
      activityFollowsCreated: true,
    })
  })
})

/**
 * The client-side single preview writer rests on two source-level properties the
 * mocked-transaction test above cannot see: `message:created` is emitted from
 * exactly ONE site, and `stream:activity` rides with it. A second emit site added
 * anywhere in `apps/backend/src` keeps that test green while silently freezing the
 * sidebar for those messages — the preview is written from `stream:activity` alone.
 *
 * Same shape as the INV-68 ratchet: one recorded count, which may only go down.
 */
describe("message:created has exactly one outbox emit site", () => {
  const EXPECTED_EMIT_SITES = { "features/messaging/event-service.ts": 1 }

  async function countEmitSites(root: string): Promise<Record<string, number>> {
    const { Glob } = await import("bun")
    const counts: Record<string, number> = {}
    for await (const file of new Glob("**/*.ts").scan({ cwd: root, absolute: true })) {
      if (file.endsWith(".test.ts") || file.endsWith(".spec.ts")) continue
      const source = await Bun.file(file).text()
      const matches = source.match(/OutboxRepository\.insert\(\s*[^,]+,\s*"message:created"/g)
      if (matches) counts[file.slice(root.length + 1)] = matches.length
    }
    return counts
  }

  it("finds the one site, in event-service.ts", async () => {
    const root = new URL("../../../src", import.meta.url).pathname.replace(/\/$/, "")
    expect(await countEmitSites(root)).toEqual(EXPECTED_EMIT_SITES)
  })
})
