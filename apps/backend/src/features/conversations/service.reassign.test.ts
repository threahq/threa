import { afterEach, describe, expect, spyOn, mock, test } from "bun:test"
import type { PoolClient } from "pg"
import { ConversationService } from "./service"
import { ConversationRepository, type Conversation } from "./repository"
import { ConversationFeedbackRepository } from "./feedback-repository"
import * as delivery from "./conversation-delivery"
import { StreamRepository } from "../streams"
import { MessageRepository, type Message } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const ACTOR_ID = "usr_1"

// One root channel with a thread under it, plus a foreign root: the three
// stream shapes the one-root rule must distinguish.
const STREAMS: Record<string, { id: string; type: string; rootStreamId: string | null; archivedAt?: Date }> = {
  chan_1: { id: "chan_1", type: "channel", rootStreamId: null },
  thread_1: { id: "thread_1", type: "thread", rootStreamId: "chan_1" },
  chan_2: { id: "chan_2", type: "channel", rootStreamId: null },
  chan_arch: { id: "chan_arch", type: "channel", rootStreamId: null, archivedAt: new Date() },
  thread_arch: { id: "thread_arch", type: "thread", rootStreamId: "chan_arch" },
}

const MESSAGES: Record<string, { streamId: string; authorId: string }> = {
  m1: { streamId: "chan_1", authorId: "usr_1" },
  m_thread: { streamId: "thread_1", authorId: "usr_2" },
  m_arch: { streamId: "chan_arch", authorId: "usr_1" },
  m_arch_thread: { streamId: "thread_arch", authorId: "usr_1" },
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_main",
    streamId: "chan_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["m1"],
    participantIds: ["usr_1"],
    secondaryMessageIds: [],
    topicSummary: "Fable",
    summary: null,
    completenessScore: 1,
    confidence: 1,
    status: "active",
    parentConversationId: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

interface Spies {
  removePrimaryMessage: ReturnType<typeof spyOn>
  addPrimaryMessage: ReturnType<typeof spyOn>
  feedbackInsert: ReturnType<typeof spyOn>
  outboxInsert: ReturnType<typeof spyOn>
}

function setup(options: {
  conversations: Record<string, Conversation>
  /** messageId → current primary conversation id. */
  primaries: Record<string, string>
}): Spies {
  const fakeClient = { query: mock(async () => ({ rows: [] })) } as unknown as PoolClient
  spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withTransaction)

  spyOn(StreamRepository, "findById").mockImplementation(
    async (_c: unknown, id: string) => (STREAMS[id] ?? null) as never
  )
  spyOn(MessageRepository, "findByIdForUpdate").mockImplementation(async (_c: unknown, id: string) => {
    const base = MESSAGES[id]
    return base ? ({ id, streamId: base.streamId, authorId: base.authorId } as unknown as Message) : null
  })

  spyOn(ConversationRepository, "findById").mockImplementation(
    async (_c: unknown, id: string) => options.conversations[id] ?? null
  )
  spyOn(ConversationRepository, "findPrimaryByMessageId").mockImplementation(async (_c, _ws, messageId: string) => {
    const convId = options.primaries[messageId]
    return convId ? (options.conversations[convId] ?? null) : null
  })
  spyOn(ConversationRepository, "findByIds").mockImplementation(async (_c, _ws, ids: string[]) =>
    ids.map((id) => options.conversations[id]).filter((c): c is Conversation => c !== undefined)
  )
  spyOn(ConversationRepository, "resolveIfEmpty").mockResolvedValue(undefined as never)
  spyOn(ConversationRepository, "reactivateIfInactive").mockResolvedValue(undefined as never)
  spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never)

  // Real thread→root delivery shape without hitting the DB: the thread resolves
  // to its parent channel, a root stream to itself.
  spyOn(delivery, "resolveConversationDelivery").mockImplementation(async (_c, stream) => {
    const s = stream as { id?: string } | null
    if (s?.id === "thread_1") return { parentStreamId: "chan_1", streamVisibility: "public" as const }
    return { parentStreamId: undefined, streamVisibility: "public" as const }
  })

  return {
    removePrimaryMessage: spyOn(ConversationRepository, "removePrimaryMessage").mockResolvedValue(undefined as never),
    addPrimaryMessage: spyOn(ConversationRepository, "addPrimaryMessage").mockResolvedValue(undefined as never),
    feedbackInsert: spyOn(ConversationFeedbackRepository, "insert").mockResolvedValue(undefined as never),
    outboxInsert: spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never),
  }
}

function service(): ConversationService {
  return new ConversationService({} as never)
}

function reassign(messageId: string, conversationId: string) {
  return service().reassignMessage({ workspaceId: WORKSPACE_ID, conversationId, messageId, userId: ACTOR_ID })
}

type Event = { type: string; payload: Record<string, any> }
function events(outboxInsert: ReturnType<typeof spyOn>): Event[] {
  return outboxInsert.mock.calls.map((c: unknown[]) => ({
    type: c[1] as string,
    payload: c[2] as Record<string, any>,
  }))
}

afterEach(() => {
  mock.restore()
})

describe("ConversationService.reassignMessage", () => {
  test("moves a root-stream message into a thread-anchored conversation under the same root", async () => {
    const convMain = makeConversation({ id: "conv_main", streamId: "chan_1", messageIds: ["m1", "m2"] })
    const convSub = makeConversation({ id: "conv_sub", streamId: "thread_1", messageIds: ["m_thread"] })
    const spies = setup({
      conversations: { conv_main: convMain, conv_sub: convSub },
      primaries: { m1: "conv_main" },
    })

    const result = await reassign("m1", "conv_sub")

    expect(spies.removePrimaryMessage.mock.calls[0]?.slice(1)).toEqual([WORKSPACE_ID, "conv_main", "m1"])
    expect(spies.addPrimaryMessage.mock.calls[0]?.slice(1)).toEqual([WORKSPACE_ID, "conv_sub", "m1", "usr_1"])
    expect(result.conversation.id).toBe("conv_sub")
    expect(result.previousConversation?.id).toBe("conv_main")

    const emitted = events(spies.outboxInsert)
    expect(emitted.find((e) => e.type === "conversation:message_reassigned")?.payload).toMatchObject({
      // The event names the MESSAGE's stream — membership moved, the row didn't.
      streamId: "chan_1",
      messageId: "m1",
      fromConversationId: "conv_main",
      toConversationId: "conv_sub",
      reason: "user_correction",
    })
    // Delivery is per conversation stream: the thread-anchored conversation
    // routes with its parent channel, the root-anchored one with none.
    const updated = emitted.filter((e) => e.type === "conversation:updated")
    expect(updated.find((e) => e.payload.conversationId === "conv_sub")?.payload.parentStreamId).toBe("chan_1")
    expect(updated.find((e) => e.payload.conversationId === "conv_main")?.payload.parentStreamId).toBeUndefined()
  })

  test("moves a thread message out to the root-anchored conversation (the undo direction)", async () => {
    const convMain = makeConversation({ id: "conv_main", streamId: "chan_1", messageIds: ["m1"] })
    const convSub = makeConversation({ id: "conv_sub", streamId: "thread_1", messageIds: ["m_thread"] })
    const spies = setup({
      conversations: { conv_main: convMain, conv_sub: convSub },
      primaries: { m_thread: "conv_sub" },
    })

    const result = await reassign("m_thread", "conv_main")

    expect(spies.addPrimaryMessage.mock.calls[0]?.slice(1)).toEqual([WORKSPACE_ID, "conv_main", "m_thread", "usr_2"])
    expect(result.conversation.id).toBe("conv_main")
  })

  test("rejects a target under a different root with CONVERSATION_NOT_IN_ROOT and writes nothing", async () => {
    const convMain = makeConversation({ id: "conv_main", streamId: "chan_1", messageIds: ["m1"] })
    const convForeign = makeConversation({ id: "conv_foreign", streamId: "chan_2", messageIds: [] })
    const spies = setup({
      conversations: { conv_main: convMain, conv_foreign: convForeign },
      primaries: { m1: "conv_main" },
    })

    await expect(reassign("m1", "conv_foreign")).rejects.toMatchObject({ code: "CONVERSATION_NOT_IN_ROOT" })
    expect(spies.removePrimaryMessage).not.toHaveBeenCalled()
    expect(spies.addPrimaryMessage).not.toHaveBeenCalled()
    expect(spies.feedbackInsert).not.toHaveBeenCalled()
    expect(spies.outboxInsert).not.toHaveBeenCalled()
  })

  test("same-stream move keeps working (the overlay path)", async () => {
    const convMain = makeConversation({ id: "conv_main", streamId: "chan_1", messageIds: ["m1"] })
    const convOther = makeConversation({ id: "conv_other", streamId: "chan_1", messageIds: [] })
    const spies = setup({
      conversations: { conv_main: convMain, conv_other: convOther },
      primaries: { m1: "conv_main" },
    })

    const result = await reassign("m1", "conv_other")

    expect(result.conversation.id).toBe("conv_other")
    expect(spies.feedbackInsert).toHaveBeenCalledTimes(1)
  })

  test("no-op when the target is already the primary", async () => {
    const convMain = makeConversation({ id: "conv_main", streamId: "chan_1", messageIds: ["m1"] })
    const spies = setup({
      conversations: { conv_main: convMain },
      primaries: { m1: "conv_main" },
    })

    const result = await reassign("m1", "conv_main")

    expect(result.previousConversation).toBeNull()
    expect(spies.feedbackInsert).not.toHaveBeenCalled()
    expect(spies.outboxInsert).not.toHaveBeenCalled()
  })
})

describe("ConversationService.reassignMessage archived streams", () => {
  test("rejects a move inside an archived stream", async () => {
    const convMain = makeConversation({ id: "conv_main", streamId: "chan_arch", messageIds: ["m_arch"] })
    const convOther = makeConversation({ id: "conv_other", streamId: "chan_arch", messageIds: [] })
    const spies = setup({
      conversations: { conv_main: convMain, conv_other: convOther },
      primaries: { m_arch: "conv_main" },
    })

    await expect(reassign("m_arch", "conv_other")).rejects.toMatchObject({ status: 403 })
    expect(spies.removePrimaryMessage).not.toHaveBeenCalled()
    expect(spies.addPrimaryMessage).not.toHaveBeenCalled()
    expect(spies.feedbackInsert).not.toHaveBeenCalled()
    expect(spies.outboxInsert).not.toHaveBeenCalled()
  })

  test("rejects a move in a thread whose root is archived (INV-62)", async () => {
    const convMain = makeConversation({ id: "conv_main", streamId: "thread_arch", messageIds: ["m_arch_thread"] })
    const convOther = makeConversation({ id: "conv_other", streamId: "thread_arch", messageIds: [] })
    const spies = setup({
      conversations: { conv_main: convMain, conv_other: convOther },
      primaries: { m_arch_thread: "conv_main" },
    })

    await expect(reassign("m_arch_thread", "conv_other")).rejects.toMatchObject({ status: 403 })
    expect(spies.addPrimaryMessage).not.toHaveBeenCalled()
  })

  test("an unarchived root still moves", async () => {
    const convMain = makeConversation({ id: "conv_main", streamId: "thread_1", messageIds: ["m_thread"] })
    const convOther = makeConversation({ id: "conv_other", streamId: "thread_1", messageIds: [] })
    const spies = setup({
      conversations: { conv_main: convMain, conv_other: convOther },
      primaries: { m_thread: "conv_main" },
    })

    const result = await reassign("m_thread", "conv_other")

    expect(result.conversation.id).toBe("conv_other")
    expect(spies.addPrimaryMessage).toHaveBeenCalledTimes(1)
  })
})
