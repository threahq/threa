import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ContextIntents, ContextRefKinds, Visibilities } from "@threa/types"
import { ThreadResolver } from "./thread-resolver"
import { AttachmentRepository, type Attachment } from "../../../attachments"
import { MessageRepository } from "../../../messaging"
import { StreamRepository, StreamMemberRepository } from "../../../streams"
import { UserRepository } from "../../../workspaces"
import { PersonaRepository } from "../../persona-repository"

// All ThreadResolver.fetch paths now batch-fetch attachments for the windowed
// message ids. Default to an empty map so individual tests don't have to
// re-stub it; tests that care about attachment rendering override locally.
beforeEach(() => {
  spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
})

function makeStream(overrides: Record<string, any> = {}): any {
  return {
    id: "stream_source",
    workspaceId: "ws_1",
    type: "channel",
    visibility: Visibilities.PRIVATE,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayName: null,
    slug: null,
    description: null,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

function makeMessage(overrides: Record<string, any> = {}): any {
  return {
    id: "msg_a",
    streamId: "stream_source",
    sequence: 1n,
    authorId: "usr_author",
    authorType: "user",
    contentMarkdown: "hello",
    contentJson: { type: "doc", content: [] },
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-04-22T09:00:00Z"),
    ...overrides,
  }
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att_1",
    workspaceId: "ws_1",
    streamId: "stream_source",
    messageId: "msg_a",
    uploadedBy: "usr_author",
    filename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12345,
    storageProvider: "s3",
    storagePath: "ws_1/att_1",
    processingStatus: "completed",
    safetyStatus: "clean",
    e2eOnly: false,
    thumbnailStoragePath: null,
    width: null,
    height: null,
    createdAt: new Date("2026-04-22T09:00:00Z"),
    ...overrides,
  }
}

describe("ThreadResolver.assertAccess", () => {
  afterEach(() => mock.restore())

  it("allows public channels without a membership check", async () => {
    const stream = makeStream({ visibility: Visibilities.PUBLIC })
    spyOn(StreamRepository, "findById").mockResolvedValue(stream)
    const isMember = spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    await ThreadResolver.assertAccess(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: stream.id },
      "usr_x",
      stream.workspaceId
    )

    expect(isMember).not.toHaveBeenCalled()
  })

  it("rejects private streams when the user is not a member", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    await expect(
      ThreadResolver.assertAccess(
        {} as any,
        { kind: ContextRefKinds.THREAD, streamId: "stream_source" },
        "usr_x",
        "ws_1"
      )
    ).rejects.toThrow(/No access/)
  })

  it("inherits visibility from the root stream for nested threads", async () => {
    const thread = makeStream({ id: "stream_thread", type: "thread", rootStreamId: "stream_root" })
    const rootPublic = makeStream({ id: "stream_root", visibility: Visibilities.PUBLIC })
    spyOn(StreamRepository, "findById").mockImplementation(async (_db: any, id: string) => {
      if (id === "stream_thread") return thread
      if (id === "stream_root") return rootPublic
      return null
    })
    const isMember = spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    await ThreadResolver.assertAccess(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_thread" },
      "usr_x",
      "ws_1"
    )

    expect(isMember).not.toHaveBeenCalled()
  })

  it("rejects when the source stream is in a different workspace", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream({ workspaceId: "ws_other" }))

    // We collapse both "missing" and "wrong workspace" into FORBIDDEN so the
    // error never confirms the existence of streams the caller can't see.
    await expect(
      ThreadResolver.assertAccess(
        {} as any,
        { kind: ContextRefKinds.THREAD, streamId: "stream_source" },
        "usr_x",
        "ws_1"
      )
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_FORBIDDEN" })
  })
})

describe("ThreadResolver.fetch", () => {
  afterEach(() => mock.restore())

  it("produces a fingerprint that changes when contentMarkdown changes", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])

    const listMock = spyOn(MessageRepository, "list")
    listMock.mockResolvedValueOnce([makeMessage({ contentMarkdown: "v1" })])
    const first = await ThreadResolver.fetch({} as any, { kind: ContextRefKinds.THREAD, streamId: "stream_source" })

    listMock.mockResolvedValueOnce([makeMessage({ contentMarkdown: "v2" })])
    const second = await ThreadResolver.fetch({} as any, { kind: ContextRefKinds.THREAD, streamId: "stream_source" })

    expect(first.fingerprint).not.toBe(second.fingerprint)
    expect(first.inputs[0].contentFingerprint).not.toBe(second.inputs[0].contentFingerprint)
  })

  it("produces the same fingerprint for unchanged content across calls", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])

    const listMock = spyOn(MessageRepository, "list")
    listMock.mockResolvedValue([makeMessage({ contentMarkdown: "stable" })])

    const a = await ThreadResolver.fetch({} as any, { kind: ContextRefKinds.THREAD, streamId: "stream_source" })
    const b = await ThreadResolver.fetch({} as any, { kind: ContextRefKinds.THREAD, streamId: "stream_source" })

    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it("throws CONTEXT_ANCHOR_NOT_FOUND when the anchor id doesn't exist in the stream at all", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([makeMessage({ id: "msg_recent" })])
    // Anchor lookup returns null → unknown id.
    spyOn(MessageRepository, "findById").mockResolvedValue(null)

    await expect(
      ThreadResolver.fetch({} as any, {
        kind: ContextRefKinds.THREAD,
        streamId: "stream_source",
        fromMessageId: "msg_gone",
      })
    ).rejects.toMatchObject({ code: "CONTEXT_ANCHOR_NOT_FOUND" })
  })

  it("throws CONTEXT_ANCHOR_OUT_OF_WINDOW when the anchor exists but predates the fetch window", async () => {
    // The anchor is a real message in the same stream — it just isn't in the
    // most-recent MAX_FETCH slice. Caller should get a different code so the
    // frontend can render an actionable error (e.g. "widen context").
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([makeMessage({ id: "msg_recent" })])
    spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage({ id: "msg_old", streamId: "stream_source" }))

    await expect(
      ThreadResolver.fetch({} as any, {
        kind: ContextRefKinds.THREAD,
        streamId: "stream_source",
        fromMessageId: "msg_old",
      })
    ).rejects.toMatchObject({ code: "CONTEXT_ANCHOR_OUT_OF_WINDOW" })
  })

  it("throws CONTEXT_ANCHOR_NOT_FOUND when the anchor exists but is soft-deleted", async () => {
    // `MessageRepository.list` filters `deleted_at IS NULL`, so a soft-deleted
    // anchor falls out of the search window and `findById` (which doesn't
    // filter) is what we'd otherwise see. Without the deletedAt guard the
    // assertion would mis-classify this as OUT_OF_WINDOW and tell the
    // frontend to widen the window — pointless, the message is gone.
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([makeMessage({ id: "msg_recent" })])
    spyOn(MessageRepository, "findById").mockResolvedValue(
      makeMessage({ id: "msg_gone", streamId: "stream_source", deletedAt: new Date() })
    )

    await expect(
      ThreadResolver.fetch({} as any, {
        kind: ContextRefKinds.THREAD,
        streamId: "stream_source",
        fromMessageId: "msg_gone",
      })
    ).rejects.toMatchObject({ code: "CONTEXT_ANCHOR_NOT_FOUND" })
  })

  it("throws CONTEXT_ANCHOR_NOT_FOUND when the anchor exists but is in a different stream", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([])
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([makeMessage({ id: "msg_recent" })])
    spyOn(MessageRepository, "findById").mockResolvedValue(
      makeMessage({ id: "msg_elsewhere", streamId: "stream_other" })
    )

    await expect(
      ThreadResolver.fetch({} as any, {
        kind: ContextRefKinds.THREAD,
        streamId: "stream_source",
        fromMessageId: "msg_elsewhere",
      })
    ).rejects.toMatchObject({ code: "CONTEXT_ANCHOR_NOT_FOUND" })
  })

  it("prepends the parent (root) message when the source is a thread", async () => {
    // Regression: threads without the root message are unintelligible.
    // Contract: we route through `MessageRepository.findThreadRoot`, so the
    // test spies on that directly rather than `findById` (the implementation
    // detail findThreadRoot calls internally).
    const thread = makeStream({
      id: "stream_thread",
      type: "thread",
      parentStreamId: "stream_root",
      parentMessageId: "msg_root",
    })
    spyOn(StreamRepository, "findById").mockResolvedValue(thread)
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([
      makeMessage({ id: "msg_reply_1", streamId: "stream_thread" }),
      makeMessage({ id: "msg_reply_2", streamId: "stream_thread" }),
    ])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(
      makeMessage({
        id: "msg_root",
        streamId: "stream_root",
        contentMarkdown: "the originating message",
      })
    )

    const result = await ThreadResolver.fetch({} as any, {
      kind: ContextRefKinds.THREAD,
      streamId: "stream_thread",
    })

    expect(result.items.map((i) => i.messageId)).toEqual(["msg_root", "msg_reply_1", "msg_reply_2"])
    expect(result.items[0].contentMarkdown).toBe("the originating message")
  })

  it("does NOT prepend a soft-deleted root (findThreadRoot returns null)", async () => {
    // The canonical helper filters `deletedAt`, so a user who deletes the
    // message that spawned a thread does not see its content leak into a
    // later Discuss-with-Ariadne invocation on that thread. This test asserts
    // the resolver honors that filter — the whole point of centralising
    // thread-root resolution in `findThreadRoot`.
    spyOn(StreamRepository, "findById").mockResolvedValue(
      makeStream({ id: "stream_thread", type: "thread", parentMessageId: "msg_deleted" })
    )
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([makeMessage({ id: "msg_reply_1", streamId: "stream_thread" })])
    // findThreadRoot returns null for soft-deleted parents.
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)

    const result = await ThreadResolver.fetch({} as any, {
      kind: ContextRefKinds.THREAD,
      streamId: "stream_thread",
    })

    expect(result.items.map((i) => i.messageId)).toEqual(["msg_reply_1"])
  })

  it("skips the root prepend when the source stream has no parentMessageId (scratchpad/channel)", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream({ parentMessageId: null }))
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([makeMessage({ id: "msg_a" })])
    // `findThreadRoot` short-circuits on parentMessageId === null without
    // touching findById. Spying on findThreadRoot exercises the real contract.
    const findThreadRoot = spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)

    const result = await ThreadResolver.fetch({} as any, {
      kind: ContextRefKinds.THREAD,
      streamId: "stream_source",
    })

    expect(result.items.map((i) => i.messageId)).toEqual(["msg_a"])
    // findThreadRoot is always called (even for non-threads) and handles the
    // parentMessageId === null case itself by returning null — verified by
    // the null result above.
    expect(findThreadRoot).toHaveBeenCalled()
  })

  it("returns the anchored slice when both endpoints resolve", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([
      makeMessage({ id: "msg_a", sequence: 1n }),
      makeMessage({ id: "msg_b", sequence: 2n }),
      makeMessage({ id: "msg_c", sequence: 3n }),
      makeMessage({ id: "msg_d", sequence: 4n }),
    ])

    const result = await ThreadResolver.fetch({} as any, {
      kind: ContextRefKinds.THREAD,
      streamId: "stream_source",
      fromMessageId: "msg_b",
      toMessageId: "msg_c",
    })

    expect(result.items.map((i) => i.messageId)).toEqual(["msg_b", "msg_c"])
  })
})

describe("ThreadResolver.fetch — DISCUSS_THREAD windowing", () => {
  // The discuss-thread intent narrows the source stream to ~50 messages
  // around an anchor instead of dumping the full tail. These tests pin the
  // shape of that window — failure mode this guards against is "Ariadne
  // gets the entire stream and can't tell what the user actually wants to
  // discuss", which is what motivated the change.
  afterEach(() => mock.restore())

  function seq(id: string, n: number): any {
    return makeMessage({ id, sequence: BigInt(n) })
  }

  it("centers a 50-message window around the focal message when the stream is large enough", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)

    // Simulate `findSurrounding` returning 50 before + focal + 50 after.
    const before = Array.from({ length: 50 }, (_, i) => seq(`msg_b${i}`, i + 1))
    const focal = seq("msg_focal", 51)
    const after = Array.from({ length: 50 }, (_, i) => seq(`msg_a${i}`, i + 52))
    const surrounding = [...before, focal, ...after]
    spyOn(MessageRepository, "findSurrounding").mockResolvedValue(surrounding)

    const result = await ThreadResolver.fetch(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_source", originMessageId: "msg_focal" },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    // 50-total window: 24 before + focal + 25 after (or 25/24, depending on
    // halving — what matters is total === 50 and focal is included).
    expect(result.items).toHaveLength(50)
    expect(result.focalMessageId).toBe("msg_focal")
    const ids = result.items.map((i) => i.messageId)
    expect(ids).toContain("msg_focal")
    expect(ids[0]).toMatch(/^msg_b/)
    expect(ids[ids.length - 1]).toMatch(/^msg_a/)
  })

  it("rebalances toward the long side when the focal sits near the start of the stream", async () => {
    // Focal at index 5: only 5 messages before it, plenty after. We should
    // see all 5 before + focal + 44 after, not 5 before + focal + 24 after.
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)

    const before = Array.from({ length: 5 }, (_, i) => seq(`msg_b${i}`, i + 1))
    const focal = seq("msg_focal", 6)
    const after = Array.from({ length: 50 }, (_, i) => seq(`msg_a${i}`, i + 7))
    spyOn(MessageRepository, "findSurrounding").mockResolvedValue([...before, focal, ...after])

    const result = await ThreadResolver.fetch(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_source", originMessageId: "msg_focal" },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    expect(result.items).toHaveLength(50)
    const ids = result.items.map((i) => i.messageId)
    expect(ids.filter((id) => id.startsWith("msg_b"))).toHaveLength(5)
    expect(ids.filter((id) => id.startsWith("msg_a"))).toHaveLength(44)
    expect(ids).toContain("msg_focal")
  })

  it("falls back to the most recent 50 when there is no originMessageId (slash command)", async () => {
    // No focal: this is the `/discuss-with-ariadne` path. We should NOT call
    // findSurrounding, just take the tail.
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)
    const findSurrounding = spyOn(MessageRepository, "findSurrounding")
    const list = spyOn(MessageRepository, "list").mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => seq(`msg_${i}`, i + 1))
    )

    const result = await ThreadResolver.fetch(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_source" },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    expect(findSurrounding).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledWith(expect.anything(), "stream_source", { limit: 50 })
    expect(result.items).toHaveLength(50)
    expect(result.focalMessageId).toBeNull()
  })

  it("drops the focal flag when the originMessageId can't be resolved in the source stream", async () => {
    // Origin id is stale or points to a different stream. `findSurrounding`
    // returns nothing; we fall back to the recent-tail slice and emit a null
    // focal so the renderer doesn't fabricate a `Focused message` section.
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)
    spyOn(MessageRepository, "findSurrounding").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([seq("msg_x", 1)])

    const result = await ThreadResolver.fetch(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_source", originMessageId: "msg_unknown" },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    expect(result.focalMessageId).toBeNull()
    expect(result.items.map((i) => i.messageId)).toEqual(["msg_x"])
  })

  it("ignores fromMessageId/toMessageId in the discuss path (windowing replaces the legacy slice)", async () => {
    // The legacy from/to anchors are still respected for non-DISCUSS_THREAD
    // intents but the discuss flow uses the centered window instead. Mixing
    // them would double-slice; this test pins that we take the window and
    // drop the anchors.
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)

    const focal = seq("msg_focal", 10)
    const surrounding = [seq("msg_a", 8), seq("msg_b", 9), focal, seq("msg_c", 11), seq("msg_d", 12)]
    spyOn(MessageRepository, "findSurrounding").mockResolvedValue(surrounding)

    const result = await ThreadResolver.fetch(
      {} as any,
      {
        kind: ContextRefKinds.THREAD,
        streamId: "stream_source",
        originMessageId: "msg_focal",
        fromMessageId: "msg_b",
        toMessageId: "msg_c",
      },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    // If anchors had been honored we'd see only msg_b..msg_c (3 items). We
    // expect the full surrounding slice instead.
    expect(result.items.map((i) => i.messageId)).toEqual(["msg_a", "msg_b", "msg_focal", "msg_c", "msg_d"])
  })

  it("does NOT keep focal state when origin matches the prepended thread root but isn't in the windowed slice", async () => {
    // Regression: a user clicking "Discuss with Ariadne" on a thread's root
    // message produces `originMessageId === root.id`. The root lives in the
    // PARENT stream, so `findSurrounding(root.id, threadStream)` returns
    // nothing and we fall through to the recent-tail slice. The thread root
    // is then prepended to `items` for context — but that prepend is a
    // rendering convenience, not "the origin is in the window." Marking the
    // root as focal in this case would synthesize a `Focused message`
    // section even though the discuss-window fallback path was taken.
    spyOn(StreamRepository, "findById").mockResolvedValue(
      makeStream({ id: "stream_thread", type: "thread", parentMessageId: "msg_root" })
    )
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findSurrounding").mockResolvedValue([])
    spyOn(MessageRepository, "list").mockResolvedValue([seq("msg_reply_1", 1), seq("msg_reply_2", 2)])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(
      makeMessage({ id: "msg_root", streamId: "stream_root", contentMarkdown: "the originating message" })
    )

    const result = await ThreadResolver.fetch(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_thread", originMessageId: "msg_root" },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    // Root is still rendered (prepend convenience) but focal is null because
    // the origin isn't in the discuss window — we want the chronological
    // render path here, not the focal-section split.
    expect(result.items.map((i) => i.messageId)).toEqual(["msg_root", "msg_reply_1", "msg_reply_2"])
    expect(result.focalMessageId).toBeNull()
  })

  it("attaches attachment metadata onto the renderable items so the trace surfaces what was attached", async () => {
    // Without this the focal message in a "Discuss with Ariadne" window
    // renders as text-only — the trace lies about the attached PDF and the
    // model has no idea anything was attached.
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)
    spyOn(MessageRepository, "list").mockResolvedValue([seq("msg_a", 1), seq("msg_b", 2)])
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(
      new Map([["msg_a", [makeAttachment({ id: "att_1", filename: "spec.pdf", sizeBytes: 12345 })]]])
    )

    const result = await ThreadResolver.fetch(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_source" },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    const itemA = result.items.find((i) => i.messageId === "msg_a")!
    const itemB = result.items.find((i) => i.messageId === "msg_b")!
    expect(itemA.attachments).toEqual([
      { id: "att_1", filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 12345 },
    ])
    expect(itemB.attachments).toBeUndefined()
  })

  it("sorts attachments by id so the rendered context-bag stays byte-stable across resolves", async () => {
    // `findByMessageIds` doesn't ORDER BY, so PG row order can drift between
    // calls. The stable region MUST hash identically across turns to preserve
    // prompt-cache reuse — pin the deterministic sort here.
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)
    spyOn(MessageRepository, "list").mockResolvedValue([seq("msg_a", 1)])
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(
      new Map([
        [
          "msg_a",
          [
            makeAttachment({ id: "att_3", filename: "c.pdf", sizeBytes: 3 }),
            makeAttachment({ id: "att_1", filename: "a.pdf", sizeBytes: 1 }),
            makeAttachment({ id: "att_2", filename: "b.pdf", sizeBytes: 2 }),
          ],
        ],
      ])
    )

    const result = await ThreadResolver.fetch(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_source" },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    const itemA = result.items.find((i) => i.messageId === "msg_a")!
    expect(itemA.attachments?.map((a) => a.id)).toEqual(["att_1", "att_2", "att_3"])
  })

  it("falls back to the stream tail (not a deletion-skewed slice) when the focal message is soft-deleted", async () => {
    // Regression: `MessageRepository.findSurrounding` looks the target's
    // sequence up without a `deleted_at` filter but excludes the target
    // itself from its neighbor query. So a soft-deleted focal produces
    // `surrounding.length > 0, targetIdx < 0`. Slicing the surrounding
    // result here would give a window skewed around the deletion point;
    // the user's anchor is unrecoverable so we return the recent-tail
    // (slash-command shape) instead. CodeRabbit caught this — the comment
    // said "no-focal fallback" but the code was lying to us.
    spyOn(StreamRepository, "findById").mockResolvedValue(makeStream())
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_author", name: "Author" }] as any)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([])
    spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)

    // Surrounding query found the deleted target's neighbors (so the array
    // is non-empty) but the target row itself was filtered out by the
    // `deleted_at IS NULL` clause on the neighbor query.
    const neighborsAroundDeletion = [seq("msg_neighbor_a", 100), seq("msg_neighbor_b", 102)]
    spyOn(MessageRepository, "findSurrounding").mockResolvedValue(neighborsAroundDeletion)
    const list = spyOn(MessageRepository, "list").mockResolvedValue([
      seq("msg_recent_1", 500),
      seq("msg_recent_2", 501),
    ])

    const result = await ThreadResolver.fetch(
      {} as any,
      { kind: ContextRefKinds.THREAD, streamId: "stream_source", originMessageId: "msg_deleted" },
      { intent: ContextIntents.DISCUSS_THREAD }
    )

    // Recent tail, not the deletion-skewed window.
    expect(list).toHaveBeenCalledWith(expect.anything(), "stream_source", { limit: 50 })
    expect(result.items.map((i) => i.messageId)).toEqual(["msg_recent_1", "msg_recent_2"])
    expect(result.focalMessageId).toBeNull()
  })
})
