import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { MessageRepository } from "./repository"

function fakeDb() {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const db = {
    async query(textOrConfig: any, values?: unknown[]) {
      const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text
      const vals = typeof textOrConfig === "string" ? (values ?? []) : (textOrConfig.values ?? [])
      queries.push({ text, values: vals })
      return { rows: [], rowCount: 0 }
    },
  }
  return { db: db as any, queries }
}

function makeMessage(overrides: Record<string, any> = {}): any {
  return {
    id: "msg_root",
    streamId: "stream_parent",
    sequence: 1n,
    authorId: "usr_author",
    authorType: "user",
    contentMarkdown: "originating message",
    contentJson: { type: "doc", content: [] },
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

describe("MessageRepository.findThreadRoot", () => {
  afterEach(() => mock.restore())

  it("returns null when the stream has no anchor", async () => {
    // Non-thread streams (channels, scratchpads, DMs) short-circuit before
    // any DB round-trip — findById must not even be consulted.
    const findById = spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage())

    const result = await MessageRepository.findThreadRoot({} as any, { parentAnchorId: null })

    expect(result).toBeNull()
    expect(findById).not.toHaveBeenCalled()
  })

  it("returns null for an event-anchored thread (no root message)", async () => {
    // Event-anchored threads hang off a card, not a message — there is no root
    // message to fetch, so the helper short-circuits before any DB round-trip.
    const findById = spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage())

    const result = await MessageRepository.findThreadRoot({} as any, { parentAnchorId: "event_1" })

    expect(result).toBeNull()
    expect(findById).not.toHaveBeenCalled()
  })

  it("returns the parent message for a thread with a live root", async () => {
    spyOn(MessageRepository, "findById").mockResolvedValue(makeMessage({ id: "msg_root" }))

    const result = await MessageRepository.findThreadRoot({} as any, { parentAnchorId: "msg_root" })

    expect(result?.id).toBe("msg_root")
  })

  it("returns null for hard-deleted roots (findById returns null)", async () => {
    spyOn(MessageRepository, "findById").mockResolvedValue(null)

    const result = await MessageRepository.findThreadRoot({} as any, { parentAnchorId: "msg_gone" })

    expect(result).toBeNull()
  })

  it("returns null for soft-deleted roots (findById returns a row with deletedAt set)", async () => {
    // Contract: the helper is the one place that filters soft-deletes so every
    // thread-context pipeline gets the same protection. If this behavior
    // regresses, a user who deletes the message that spawned a thread will see
    // its original content leak back into the AI prompt on every subsequent
    // Discuss-with-Ariadne invocation against that thread.
    spyOn(MessageRepository, "findById").mockResolvedValue(
      makeMessage({ id: "msg_deleted", deletedAt: new Date("2026-04-20T10:00:00Z") })
    )

    const result = await MessageRepository.findThreadRoot({} as any, { parentAnchorId: "msg_deleted" })

    expect(result).toBeNull()
  })
})

describe("MessageRepository.updateStreamScopedReferences", () => {
  it("re-stamps shared_messages on both sides — source-of-share and share-message-target", async () => {
    // Pin the columns the batch move-to-thread flow must keep in sync. A
    // moved message can be a SOURCE (shared elsewhere) or the SHARE MESSAGE
    // itself (its body contains a sharedMessage node). Both columns are
    // denormalized on shared_messages; without this re-stamp,
    // pointer:invalidated fans out to the old room and any future joins on
    // shared_messages.source_stream_id resolve to the wrong stream.
    const { db, queries } = fakeDb()

    await MessageRepository.updateStreamScopedReferences(db, {
      workspaceId: "ws_1",
      sourceStreamId: "stream_src",
      destinationStreamId: "stream_dst",
      messageIds: ["msg_a", "msg_b"],
    })

    const sharedMessageQueries = queries.filter((q) => /UPDATE shared_messages/i.test(q.text))
    expect(sharedMessageQueries).toHaveLength(2)

    const sourceSideQuery = sharedMessageQueries.find((q) =>
      /source_stream_id\s*=/.test(q.text.split("WHERE")[1] ?? "")
    )
    const targetSideQuery = sharedMessageQueries.find((q) =>
      /target_stream_id\s*=/.test(q.text.split("WHERE")[1] ?? "")
    )

    expect(sourceSideQuery).toBeDefined()
    expect(sourceSideQuery!.text).toMatch(/source_message_id\s*=\s*ANY/i)
    expect(sourceSideQuery!.values).toEqual(["stream_dst", "ws_1", "stream_src", ["msg_a", "msg_b"]])

    expect(targetSideQuery).toBeDefined()
    expect(targetSideQuery!.text).toMatch(/share_message_id\s*=\s*ANY/i)
    expect(targetSideQuery!.values).toEqual(["stream_dst", "ws_1", "stream_src", ["msg_a", "msg_b"]])
  })

  it("is a no-op when messageIds is empty (no rows to re-stamp)", async () => {
    const { db, queries } = fakeDb()

    await MessageRepository.updateStreamScopedReferences(db, {
      workspaceId: "ws_1",
      sourceStreamId: "stream_src",
      destinationStreamId: "stream_dst",
      messageIds: [],
    })

    expect(queries).toEqual([])
  })
})
