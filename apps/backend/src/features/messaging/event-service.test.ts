import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { AttachmentSafetyStatuses, E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"
import { EventService } from "./event-service"
import { MessageRepository } from "./repository"
import { SharedMessageRepository } from "./sharing/repository"
import { MessageVersionRepository } from "./version-repository"
import { StreamEventRepository, StreamMemberRepository, StreamRepository } from "../streams"
import { AttachmentRepository, AttachmentReferenceRepository } from "../attachments"
import { OutboxRepository } from "../../lib/outbox"
import * as db from "../../db"
import { messagesTotal } from "../../lib/observability"
import { StreamPersonaParticipantRepository } from "../agents"
import { E2eStreamsRepository } from "../e2e-streams"

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
    spyOn(StreamMemberRepository, "update").mockResolvedValue(undefined as any)
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
    spyOn(StreamMemberRepository, "update").mockResolvedValue(undefined as any)
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
    spyOn(StreamMemberRepository, "update").mockResolvedValue(undefined as any)
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
  }
  let findByIdForUpdateSpy: ReturnType<typeof spyOn>
  let isMemberSpy: ReturnType<typeof spyOn>
  let hasParticipatedSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    spyOn(db, "withTransaction").mockImplementation(((_db: unknown, callback: (client: any) => Promise<unknown>) =>
      callback({})) as any)
    findByIdForUpdateSpy = spyOn(MessageRepository, "findByIdForUpdate").mockResolvedValue(existingMessage as any)
    spyOn(MessageRepository, "findById").mockResolvedValue(existingMessage as any)
    // editMessage refuses edits in E2E streams at the sink (INV-E1); default to
    // non-E2E so the plaintext edit path runs.
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    // editMessage now looks up the stream post-edit to decide whether to
    // publish a thread-summary update to the parent (for reply edits). Default
    // to a non-thread stream so the publishParentThreadUpdate branch short-
    // circuits — tests that care about the thread path can override per case.
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
    // Edit path now also refreshes the attachment_references projection in
    // the same transaction; default mocks let the version-capture tests run
    // without exercising the projection. Tests that care override these.
    spyOn(AttachmentReferenceRepository, "deleteByMessageId").mockResolvedValue(0)
    spyOn(AttachmentReferenceRepository, "insertMany").mockResolvedValue(0)
  })

  afterEach(() => {
    mock.restore()
  })

  it("should snapshot pre-edit content as a version record", async () => {
    const service = new EventService({} as any)

    await service.editMessage({
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
        contentJson: existingMessage.contentJson,
        contentMarkdown: "original",
        editedBy: "usr_1",
      })
    )
  })

  it("should not create version when message does not exist", async () => {
    findByIdForUpdateSpy.mockResolvedValue(null)

    const service = new EventService({} as any)

    await service.editMessage({
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

    await service.editMessage({
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
      service.editMessage({
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

    await service.editMessage({
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
    // editMessage refuses edits in E2E streams at the sink (INV-E1).
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
    await service.editMessage({
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
    await service.editMessage({
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
      service.editMessage({
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
    spyOn(StreamMemberRepository, "update").mockResolvedValue(undefined as any)
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
      service.editMessage({
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
