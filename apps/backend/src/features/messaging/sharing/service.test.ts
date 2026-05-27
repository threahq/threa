import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { JSONContent } from "@threa/types"
import { collectShareReferences, ShareService } from "./service"
import { SharedMessageRepository } from "./repository"
import * as accessCheck from "./access-check"
import { MessageRepository } from "../repository"
import { E2eStreamsRepository } from "../../e2e-streams"

describe("collectShareReferences", () => {
  it("returns an empty list when no share nodes are present", () => {
    const doc: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }
    expect(collectShareReferences(doc, "stream_target")).toEqual([])
  })

  it("extracts every cross-stream sharedMessage node as a pointer reference", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "sharedMessage",
          attrs: { messageId: "msg_a", streamId: "stream_source_1" },
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "commentary" }],
        },
        {
          type: "sharedMessage",
          attrs: { messageId: "msg_b", streamId: "stream_source_2" },
        },
      ],
    }

    expect(collectShareReferences(doc, "stream_target")).toEqual([
      { flavor: "pointer", sourceMessageId: "msg_a", sourceStreamId: "stream_source_1" },
      { flavor: "pointer", sourceMessageId: "msg_b", sourceStreamId: "stream_source_2" },
    ])
  })

  it("flags cross-stream quoteReply nodes as quote-flavor references", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "quoteReply",
          attrs: {
            messageId: "msg_x",
            streamId: "stream_source",
            authorId: "usr_1",
            authorName: "Alice",
            actorType: "user",
            snippet: "hello",
          },
        },
      ],
    }
    expect(collectShareReferences(doc, "stream_target")).toEqual([
      { flavor: "quote", sourceMessageId: "msg_x", sourceStreamId: "stream_source" },
    ])
  })

  it("treats same-stream quoteReply as an in-stream quote, not a share", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "quoteReply",
          attrs: {
            messageId: "msg_x",
            streamId: "stream_target",
            authorId: "usr_1",
            authorName: "Alice",
            actorType: "user",
            snippet: "hello",
          },
        },
      ],
    }
    expect(collectShareReferences(doc, "stream_target")).toEqual([])
  })
})

describe("ShareService.validateAndRecordShares", () => {
  const sourceMessage = {
    id: "msg_source",
    streamId: "stream_source",
    workspaceId: "ws_1",
    contentJson: { type: "doc" },
    contentMarkdown: "hello",
  } as any

  const sourceStream = {
    id: "stream_source",
    workspaceId: "ws_1",
    visibility: "private" as const,
    rootStreamId: null,
  }

  function findStreamStub(overrides: Partial<typeof sourceStream> = {}) {
    return async () => ({ ...sourceStream, ...overrides }) as any
  }

  const isAncestorStub = async () => false
  const countExposedMembersStub = async () => 0
  const canReadStreamStub = async () => true
  // Default resolver — no-op: returns the source as-is. Tests covering
  // thread → root resolution semantics live in `access-check.test.ts`.
  const resolveEffectiveStreamStub = async (_db: unknown, source: any) => source

  function baseParams(extras: Partial<Parameters<typeof ShareService.validateAndRecordShares>[0]> = {}) {
    return {
      client: {} as any,
      workspaceId: "ws_1",
      targetStreamId: "stream_target",
      shareMessageId: "msg_share",
      sharerId: "usr_1",
      findStream: findStreamStub(),
      resolveEffectiveStream: resolveEffectiveStreamStub,
      isAncestor: isAncestorStub,
      countExposedMembers: countExposedMembersStub,
      canReadStream: canReadStreamStub,
      contentJson: {
        type: "doc",
        content: [{ type: "sharedMessage", attrs: { messageId: "msg_source", streamId: "stream_source" } }],
      } as any,
      ...extras,
    }
  }

  beforeEach(() => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map([[sourceMessage.id, sourceMessage]]))
    spyOn(SharedMessageRepository, "insert").mockResolvedValue({} as any)
    spyOn(SharedMessageRepository, "deleteByShareMessageId").mockResolvedValue(undefined)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  })

  afterEach(() => {
    mock.restore()
  })

  it("is a no-op when the message contains no share references", async () => {
    await ShareService.validateAndRecordShares(
      baseParams({ contentJson: { type: "doc", content: [{ type: "paragraph" }] } as any })
    )
    expect(SharedMessageRepository.insert).not.toHaveBeenCalled()
  })

  it("writes a shared_messages row for each cross-stream share node", async () => {
    spyOn(accessCheck, "crossesPrivacyBoundary").mockResolvedValue({ triggered: false, exposedUserCount: 0 })

    await ShareService.validateAndRecordShares(baseParams())

    expect(SharedMessageRepository.insert).toHaveBeenCalledTimes(1)
    const call = (SharedMessageRepository.insert as any).mock.calls[0][1]
    expect(call).toMatchObject({
      workspaceId: "ws_1",
      shareMessageId: "msg_share",
      sourceMessageId: "msg_source",
      sourceStreamId: "stream_source",
      targetStreamId: "stream_target",
      flavor: "pointer",
      createdBy: "usr_1",
    })
  })

  it("rejects cross-workspace shares", async () => {
    await expect(
      ShareService.validateAndRecordShares(baseParams({ findStream: findStreamStub({ workspaceId: "ws_other" }) }))
    ).rejects.toMatchObject({ status: 400, code: "SHARE_CROSS_WORKSPACE_FORBIDDEN" })

    expect(SharedMessageRepository.insert).not.toHaveBeenCalled()
  })

  it("rejects shares that cross a privacy boundary without confirmation", async () => {
    spyOn(accessCheck, "crossesPrivacyBoundary").mockResolvedValue({ triggered: true, exposedUserCount: 2 })

    await expect(ShareService.validateAndRecordShares(baseParams())).rejects.toMatchObject({
      status: 409,
      code: "SHARE_PRIVACY_CONFIRMATION_REQUIRED",
    })

    expect(SharedMessageRepository.insert).not.toHaveBeenCalled()
  })

  it("accepts privacy-crossing shares when the sharer confirmed", async () => {
    spyOn(accessCheck, "crossesPrivacyBoundary").mockResolvedValue({ triggered: true, exposedUserCount: 2 })
    await ShareService.validateAndRecordShares(baseParams({ confirmedPrivacyWarning: true }))
    expect(SharedMessageRepository.insert).toHaveBeenCalledTimes(1)
  })

  it("fails when the referenced source message does not exist", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    await expect(
      ShareService.validateAndRecordShares(
        baseParams({
          contentJson: {
            type: "doc",
            content: [{ type: "sharedMessage", attrs: { messageId: "msg_missing", streamId: "stream_source" } }],
          } as any,
        })
      )
    ).rejects.toMatchObject({ status: 400, code: "SHARE_SOURCE_MESSAGE_NOT_FOUND" })
  })

  it("fails when the source message belongs to a different stream than claimed", async () => {
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
      new Map([[sourceMessage.id, { ...sourceMessage, streamId: "stream_other" }]])
    )
    await expect(ShareService.validateAndRecordShares(baseParams())).rejects.toMatchObject({
      status: 400,
      code: "SHARE_SOURCE_STREAM_MISMATCH",
    })
  })

  it("dedupes per-stream callbacks across duplicate references (INV-56 batching)", async () => {
    const findStream = mock(async () => ({ ...sourceStream }) as any)
    const isAncestor = mock(async () => false)
    const countExposedMembers = mock(async () => 0)
    const canReadStream = mock(async () => true)
    spyOn(accessCheck, "crossesPrivacyBoundary").mockResolvedValue({ triggered: false, exposedUserCount: 0 })

    // Two share-nodes pointing at the same source — per-stream callbacks
    // should fire once each, not twice.
    await ShareService.validateAndRecordShares(
      baseParams({
        findStream,
        isAncestor,
        countExposedMembers,
        canReadStream,
        contentJson: {
          type: "doc",
          content: [
            { type: "sharedMessage", attrs: { messageId: "msg_source", streamId: "stream_source" } },
            { type: "sharedMessage", attrs: { messageId: "msg_source", streamId: "stream_source" } },
          ],
        } as any,
      })
    )

    expect(findStream).toHaveBeenCalledTimes(1)
    expect(canReadStream).toHaveBeenCalledTimes(1)
    expect(MessageRepository.findByIdsInWorkspace).toHaveBeenCalledTimes(1)
    expect(SharedMessageRepository.insert).toHaveBeenCalledTimes(2)
  })

  it("rejects shares whose source stream is end-to-end encrypted", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    await expect(ShareService.validateAndRecordShares(baseParams())).rejects.toMatchObject({
      status: 400,
      code: "SHARE_E2E_NOT_ALLOWED",
    })
    expect(SharedMessageRepository.insert).not.toHaveBeenCalled()
  })

  it("rejects shares when the sharer cannot read the source stream", async () => {
    await expect(
      ShareService.validateAndRecordShares(baseParams({ canReadStream: async () => false }))
    ).rejects.toMatchObject({
      status: 403,
      code: "SHARE_SOURCE_FORBIDDEN",
    })
    expect(SharedMessageRepository.insert).not.toHaveBeenCalled()
  })

  it("deletes previously recorded shares before re-inserting (idempotent for edits)", async () => {
    spyOn(accessCheck, "crossesPrivacyBoundary").mockResolvedValue({ triggered: false, exposedUserCount: 0 })
    await ShareService.validateAndRecordShares(baseParams())
    expect(SharedMessageRepository.deleteByShareMessageId).toHaveBeenCalledTimes(1)
    expect(SharedMessageRepository.deleteByShareMessageId).toHaveBeenCalledWith({}, "ws_1", "msg_share")
  })
})
