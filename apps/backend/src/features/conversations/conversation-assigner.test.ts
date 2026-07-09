import { describe, test, expect, spyOn, mock, beforeEach, afterEach } from "bun:test"
import { conversationAssigner } from "./conversation-assigner"
import { ConversationRepository, type Conversation } from "./repository"
import * as assignmentEvents from "./assignment-events"
import * as streams from "../streams"
import type { Message } from "../messaging"

// The assigner only passes `client` through to the (spied) repositories, so a
// dummy stands in for a real PoolClient.
const CLIENT = {} as never
const WORKSPACE_ID = "ws_1"

// The thread (`thr_1`) hangs off `msg_open` in `chan_1`; `chan_1`/`chan_2` are
// top-level roots; `thr_1`'s effective root is `chan_1`.
const STREAMS: Record<string, unknown> = {
  thr_1: { id: "thr_1", parentStreamId: "chan_1", parentMessageId: "msg_open", rootStreamId: "chan_1" },
  chan_1: { id: "chan_1", parentStreamId: null, parentMessageId: null, rootStreamId: null },
  chan_2: { id: "chan_2", parentStreamId: null, parentMessageId: null, rootStreamId: null },
}

function makeReply(streamId = "thr_1"): Message {
  return { id: "msg_reply", streamId, authorId: "usr_1" } as unknown as Message
}

function makeSource(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_src",
    streamId: "chan_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["msg_open"],
    ...overrides,
  } as unknown as Conversation
}

describe("conversationAssigner — threadFromMessage", () => {
  let insert: ReturnType<typeof spyOn>
  let addPrimaryMessage: ReturnType<typeof spyOn>
  let emitAssignmentEvents: ReturnType<typeof spyOn>
  let findByIdForUpdate: ReturnType<typeof spyOn>
  let checkStreamAccess: ReturnType<typeof spyOn>

  beforeEach(() => {
    insert = spyOn(ConversationRepository, "insert").mockResolvedValue({ id: "conv_new" } as never)
    addPrimaryMessage = spyOn(ConversationRepository, "addPrimaryMessage").mockResolvedValue(undefined as never)
    spyOn(ConversationRepository, "reactivateIfInactive").mockResolvedValue(undefined as never)
    spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never)
    emitAssignmentEvents = spyOn(assignmentEvents, "emitAssignmentEvents").mockResolvedValue(undefined as never)
    findByIdForUpdate = spyOn(ConversationRepository, "findByIdForUpdate")
    spyOn(streams.StreamRepository, "findById").mockImplementation(
      async (_client: unknown, id: string) => (STREAMS[id] ?? null) as never
    )
    checkStreamAccess = spyOn(streams, "checkStreamAccess").mockResolvedValue({ id: "chan_1" } as never)
  })

  afterEach(() => {
    mock.restore()
  })

  async function thread(sourceConversationId: string, reply = makeReply()): Promise<string> {
    return conversationAssigner.assignInTransaction(CLIENT, {
      workspaceId: WORKSPACE_ID,
      message: reply,
      directive: { intent: "threadFromMessage", sourceConversationId },
    })
  }

  test("attaches the reply to the SAME source conversation — one conversation, no mint", async () => {
    findByIdForUpdate.mockResolvedValue(makeSource())

    // Returns the joined source id so the caller can surface it on the send.
    expect(await thread("conv_src")).toBe("conv_src")

    // The reply joins the source as a cross-stream member; nothing is minted.
    expect(insert).not.toHaveBeenCalled()
    expect(addPrimaryMessage).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_src", "msg_reply", "usr_1")
    expect(emitAssignmentEvents.mock.calls[0][1]).toMatchObject({
      conversationId: "conv_src",
      created: false,
      message: expect.objectContaining({ id: "msg_reply" }),
    })
  })

  test("attaches even when the source already spans messages (relaxed from lone-only)", async () => {
    findByIdForUpdate.mockResolvedValue(makeSource({ messageIds: ["msg_open", "msg_other"] }))

    await thread("conv_src")

    expect(insert).not.toHaveBeenCalled()
    expect(addPrimaryMessage).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_src", "msg_reply", "usr_1")
  })

  test("falls back to minting a conversation when the source is missing/foreign (reply never orphaned)", async () => {
    findByIdForUpdate.mockResolvedValue(null)

    const returned = await thread("conv_gone")

    // No source to attach to → mint a fresh conversation in the thread stream,
    // and return that minted id (never orphaned, never the missing source id).
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][1]).toMatchObject({ streamId: "thr_1", workspaceId: WORKSPACE_ID })
    expect(returned).toBe(insert.mock.calls[0][1].id as string)
    expect(emitAssignmentEvents.mock.calls[0][1]).toMatchObject({ created: true })
  })

  test("falls back to minting when the actor cannot access the source (crafted id)", async () => {
    findByIdForUpdate.mockResolvedValue(makeSource())
    checkStreamAccess.mockResolvedValue(null)

    await thread("conv_src")

    expect(checkStreamAccess).toHaveBeenCalledWith(CLIENT, "chan_1", WORKSPACE_ID, "usr_1")
    expect(addPrimaryMessage).not.toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_src", "msg_reply", "usr_1")
    expect(insert).toHaveBeenCalledTimes(1)
  })

  test("falls back to minting when the source isn't anchored at the thread's parent", async () => {
    // Accessible, but its message isn't the thread's parent (`msg_open`).
    findByIdForUpdate.mockResolvedValue(makeSource({ id: "conv_other", messageIds: ["msg_unrelated"] }))

    await thread("conv_other")

    expect(addPrimaryMessage).not.toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_other", "msg_reply", "usr_1")
    expect(insert).toHaveBeenCalledTimes(1)
  })
})

describe("conversationAssigner — newSubtopic (declared branch, stream-locked mint)", () => {
  // The assigner locks the thread stream row before find-or-mint, so the client
  // needs a `query` that resolves (the real path runs `SELECT … FOR UPDATE`).
  const LOCK_CLIENT = { query: mock(async () => ({ rows: [] })) } as never
  let insert: ReturnType<typeof spyOn>
  let addPrimaryMessage: ReturnType<typeof spyOn>
  let bumpActivityForIds: ReturnType<typeof spyOn>
  let emitAssignmentEvents: ReturnType<typeof spyOn>
  let findActiveByStream: ReturnType<typeof spyOn>

  beforeEach(() => {
    insert = spyOn(ConversationRepository, "insert").mockResolvedValue({ id: "conv_new" } as never)
    addPrimaryMessage = spyOn(ConversationRepository, "addPrimaryMessage").mockResolvedValue(undefined as never)
    bumpActivityForIds = spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never)
    emitAssignmentEvents = spyOn(assignmentEvents, "emitAssignmentEvents").mockResolvedValue(undefined as never)
    findActiveByStream = spyOn(ConversationRepository, "findActiveByStream")
  })

  afterEach(() => {
    mock.restore()
  })

  async function newSubtopic(reply = makeReply("thr_1")): Promise<string> {
    return conversationAssigner.assignInTransaction(LOCK_CLIENT, {
      workspaceId: WORKSPACE_ID,
      message: reply,
      directive: { intent: "newSubtopic" },
    })
  }

  test("mints a fresh conversation anchored to the thread stream when none is active there", async () => {
    findActiveByStream.mockResolvedValue([])

    const returned = await newSubtopic()

    // Locks the thread stream row before deciding (INV-20), then mints anchored to
    // the thread — the branch relationship (thr_1.parentMessageId ∈ the parent
    // conversation) is derivable from the graph, so no parent id is written.
    expect((LOCK_CLIENT as { query: ReturnType<typeof mock> }).query).toHaveBeenCalled()
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][1]).toMatchObject({ streamId: "thr_1", workspaceId: WORKSPACE_ID })
    // The mint generates its own id; the reply joins that same conversation.
    const mintedId = insert.mock.calls[0][1].id as string
    expect(returned).toBe(mintedId)
    expect(addPrimaryMessage).toHaveBeenCalledWith(LOCK_CLIENT, WORKSPACE_ID, mintedId, "msg_reply", "usr_1")
    expect(bumpActivityForIds).toHaveBeenCalledWith(LOCK_CLIENT, WORKSPACE_ID, [mintedId])
    expect(emitAssignmentEvents.mock.calls[0][1]).toMatchObject({
      conversationId: mintedId,
      created: true,
      reason: "declared",
    })
  })

  test("the minted child anchors to a thread whose fork message is a member of the parent conversation", async () => {
    findActiveByStream.mockResolvedValue([])

    await newSubtopic()

    // The child is anchored to `message.streamId` (thr_1). The parent card renders
    // the stub because thr_1's `parentMessageId` (msg_open) is a member message of
    // the parent conversation — the graph link the PR1 renderer derives.
    const mintedAnchor = insert.mock.calls[0][1].streamId as string
    const thread = STREAMS[mintedAnchor] as { parentMessageId: string }
    const parentConversation = makeSource() // messageIds: ["msg_open"]
    expect(parentConversation.messageIds).toContain(thread.parentMessageId)
  })

  test("a second newSubtopic into the same thread attaches to the existing conversation (no double-mint)", async () => {
    // The two-users race: the loser sees the winner's conversation via the
    // stream lock + findActiveByStream and attaches instead of minting again.
    findActiveByStream.mockResolvedValue([{ id: "conv_sub", streamId: "thr_1" } as unknown as Conversation])

    expect(await newSubtopic()).toBe("conv_sub")

    expect(insert).not.toHaveBeenCalled()
    expect(addPrimaryMessage).toHaveBeenCalledWith(LOCK_CLIENT, WORKSPACE_ID, "conv_sub", "msg_reply", "usr_1")
    expect(bumpActivityForIds).toHaveBeenCalledWith(LOCK_CLIENT, WORKSPACE_ID, ["conv_sub"])
    expect(emitAssignmentEvents.mock.calls[0][1]).toMatchObject({
      conversationId: "conv_sub",
      created: false,
      reason: "declared",
    })
  })
})

describe("conversationAssigner — existing (same-root guard)", () => {
  let addPrimaryMessage: ReturnType<typeof spyOn>
  let emitAssignmentEvents: ReturnType<typeof spyOn>
  let findByIdForUpdate: ReturnType<typeof spyOn>

  beforeEach(() => {
    addPrimaryMessage = spyOn(ConversationRepository, "addPrimaryMessage").mockResolvedValue(undefined as never)
    spyOn(ConversationRepository, "reactivateIfInactive").mockResolvedValue(undefined as never)
    spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never)
    emitAssignmentEvents = spyOn(assignmentEvents, "emitAssignmentEvents").mockResolvedValue(undefined as never)
    findByIdForUpdate = spyOn(ConversationRepository, "findByIdForUpdate")
    spyOn(streams.StreamRepository, "findById").mockImplementation(
      async (_client: unknown, id: string) => (STREAMS[id] ?? null) as never
    )
  })

  afterEach(() => {
    mock.restore()
  })

  async function existing(target: Conversation, reply: Message): Promise<string> {
    findByIdForUpdate.mockResolvedValue(target)
    return conversationAssigner.assignInTransaction(CLIENT, {
      workspaceId: WORKSPACE_ID,
      message: reply,
      directive: { intent: "existing", conversationId: target.id },
    })
  }

  test("attaches a same-stream reply", async () => {
    expect(await existing(makeSource({ id: "conv_a", streamId: "chan_1" }), makeReply("chan_1"))).toBe("conv_a")
    expect(addPrimaryMessage).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_a", "msg_reply", "usr_1")
  })

  test("attaches a reply from a thread under the conversation's root (cross-stream, same root)", async () => {
    // Conversation anchored at `chan_1`; reply lands in its thread `thr_1`.
    await existing(makeSource({ id: "conv_a", streamId: "chan_1" }), makeReply("thr_1"))
    expect(addPrimaryMessage).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_a", "msg_reply", "usr_1")
  })

  test("rejects a cross-root attach", async () => {
    // Conversation anchored at `chan_2`; reply lives under `chan_1`'s thread.
    await expect(existing(makeSource({ id: "conv_a", streamId: "chan_2" }), makeReply("thr_1"))).rejects.toMatchObject({
      code: "CONVERSATION_NOT_IN_ROOT",
    })
    expect(addPrimaryMessage).not.toHaveBeenCalled()
    expect(emitAssignmentEvents).not.toHaveBeenCalled()
  })

  test("rejects a missing/foreign conversation id", async () => {
    findByIdForUpdate.mockResolvedValue(null)
    await expect(
      conversationAssigner.assignInTransaction(CLIENT, {
        workspaceId: WORKSPACE_ID,
        message: makeReply("chan_1"),
        directive: { intent: "existing", conversationId: "conv_gone" },
      })
    ).rejects.toMatchObject({ code: "CONVERSATION_NOT_FOUND" })
  })
})

describe("conversationAssigner — new (client-minted id)", () => {
  let insert: ReturnType<typeof spyOn>
  let addPrimaryMessage: ReturnType<typeof spyOn>
  let emitAssignmentEvents: ReturnType<typeof spyOn>

  beforeEach(() => {
    insert = spyOn(ConversationRepository, "insert").mockResolvedValue({ id: "conv_new" } as never)
    addPrimaryMessage = spyOn(ConversationRepository, "addPrimaryMessage").mockResolvedValue(undefined as never)
    spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never)
    emitAssignmentEvents = spyOn(assignmentEvents, "emitAssignmentEvents").mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    mock.restore()
  })

  async function mintNew(conversationId?: string): Promise<string> {
    return conversationAssigner.assignInTransaction(CLIENT, {
      workspaceId: WORKSPACE_ID,
      message: makeReply("chan_1"),
      directive: { intent: "new", conversationId },
    })
  }

  test("honors the client-minted id verbatim so the optimistic card reconciles by it", async () => {
    const returned = await mintNew("conv_client")

    expect(insert.mock.calls[0][1]).toMatchObject({
      id: "conv_client",
      streamId: "chan_1",
      workspaceId: WORKSPACE_ID,
    })
    expect(addPrimaryMessage).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, "conv_client", "msg_reply", "usr_1")
    expect(returned).toBe("conv_client")
    expect(emitAssignmentEvents.mock.calls[0][1]).toMatchObject({
      conversationId: "conv_client",
      created: true,
      reason: "declared",
    })
  })

  test("mints a server id when the sender supplies none (every non-board `new` caller)", async () => {
    const returned = await mintNew(undefined)

    const mintedId = insert.mock.calls[0][1].id as string
    expect(mintedId).toMatch(/^conv_/)
    expect(returned).toBe(mintedId)
    expect(addPrimaryMessage).toHaveBeenCalledWith(CLIENT, WORKSPACE_ID, mintedId, "msg_reply", "usr_1")
  })
})
