import { afterEach, beforeEach, describe, expect, spyOn, mock, test } from "bun:test"
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

// `chan_1` is the root; `thr_1` hangs off `msg_open`; `thr_2` is a deeper
// sub-topic under `thr_1` (a descendant thread whose members move with it).
const STREAMS: Record<string, unknown> = {
  chan_1: { id: "chan_1", type: "channel", parentStreamId: null, parentAnchorId: null, rootStreamId: null },
  thr_1: { id: "thr_1", type: "thread", parentStreamId: "chan_1", parentAnchorId: "msg_open", rootStreamId: "chan_1" },
  thr_2: { id: "thr_2", type: "thread", parentStreamId: "thr_1", parentAnchorId: "msg_t1", rootStreamId: "chan_1" },
  // A thread under a DIFFERENT root — the same-root guard's negative case.
  thr_foreign: {
    id: "thr_foreign",
    type: "thread",
    parentStreamId: "chan_2",
    parentAnchorId: "msg_x",
    rootStreamId: "chan_2",
  },
}

const MESSAGES: Record<string, { streamId: string; authorId: string }> = {
  msg_open: { streamId: "chan_1", authorId: "usr_1" },
  msg_root2: { streamId: "chan_1", authorId: "usr_2" },
  msg_t1: { streamId: "thr_1", authorId: "usr_1" },
  msg_t2: { streamId: "thr_1", authorId: "usr_2" },
  msg_t2sub: { streamId: "thr_2", authorId: "usr_1" },
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_src",
    streamId: "chan_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["msg_open", "msg_root2", "msg_t1", "msg_t2", "msg_t2sub"],
    participantIds: ["usr_1", "usr_2"],
    secondaryMessageIds: [],
    topicSummary: "Parent topic",
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

function messageMap(ids: string[]): Map<string, Message> {
  const map = new Map<string, Message>()
  for (const id of ids) {
    const base = MESSAGES[id]
    if (base) map.set(id, { id, streamId: base.streamId, authorId: base.authorId } as unknown as Message)
  }
  return map
}

interface SplitSpies {
  insert: ReturnType<typeof spyOn>
  removePrimaryMessages: ReturnType<typeof spyOn>
  addPrimaryMessages: ReturnType<typeof spyOn>
  bumpActivityForIds: ReturnType<typeof spyOn>
  feedbackInsertMany: ReturnType<typeof spyOn>
  outboxInsert: ReturnType<typeof spyOn>
}

function setup(options?: {
  source?: Conversation
  streamOverrides?: Record<string, unknown>
  subtree?: string[]
}): SplitSpies {
  const fakeClient = { query: mock(async () => ({ rows: [] })) } as unknown as PoolClient
  spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withTransaction)

  const streams = { ...STREAMS, ...(options?.streamOverrides ?? {}) }
  spyOn(StreamRepository, "findById").mockImplementation(
    async (_c: unknown, id: string) => (streams[id] ?? null) as never
  )
  spyOn(StreamRepository, "listSelfAndDescendantIds").mockResolvedValue(options?.subtree ?? ["thr_1", "thr_2"])

  const source = options?.source ?? makeConversation()
  spyOn(ConversationRepository, "findByIdForUpdate").mockResolvedValue(source)
  spyOn(ConversationRepository, "findById").mockImplementation(async (_c: unknown, id: string) => {
    if (id === source.id) {
      return makeConversation({
        id: source.id,
        messageIds: ["msg_open", "msg_root2"],
        participantIds: ["usr_1", "usr_2"],
      })
    }
    return makeConversation({
      id,
      streamId: "thr_1",
      topicSummary: null,
      messageIds: ["msg_t1", "msg_t2", "msg_t2sub"],
      participantIds: ["usr_1", "usr_2"],
    })
  })

  spyOn(MessageRepository, "findByIds").mockResolvedValue(messageMap(source.messageIds))
  spyOn(MessageRepository, "findByIdsForUpdate").mockResolvedValue([])

  spyOn(delivery, "resolveConversationDelivery").mockResolvedValue({
    parentStreamId: "chan_1",
    streamVisibility: "public",
  })

  const insert = spyOn(ConversationRepository, "insert").mockResolvedValue({ id: "conv_new" } as never)
  const removePrimaryMessages = spyOn(ConversationRepository, "removePrimaryMessages").mockResolvedValue(
    undefined as never
  )
  const addPrimaryMessages = spyOn(ConversationRepository, "addPrimaryMessages").mockResolvedValue(undefined as never)
  const bumpActivityForIds = spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never)
  const feedbackInsertMany = spyOn(ConversationFeedbackRepository, "insertMany").mockResolvedValue(undefined as never)
  const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

  return { insert, removePrimaryMessages, addPrimaryMessages, bumpActivityForIds, feedbackInsertMany, outboxInsert }
}

function service(): ConversationService {
  return new ConversationService({} as never)
}

async function split(threadStreamId = "thr_1", conversationId = "conv_src") {
  return service().splitThreadIntoConversation({
    workspaceId: WORKSPACE_ID,
    conversationId,
    threadStreamId,
    actorUserId: ACTOR_ID,
  })
}

describe("ConversationService.splitThreadIntoConversation", () => {
  afterEach(() => mock.restore())

  test("moves the thread's members (incl. a descendant thread's) to a new thread-anchored conversation", async () => {
    const spies = setup()

    const result = await split()

    // Minted anchored to the thread, following the fresh-mint precedent — no
    // copied parent title (adjustment F), status active, confidence 1.
    expect(spies.insert).toHaveBeenCalledTimes(1)
    expect(spies.insert.mock.calls[0][1]).toMatchObject({
      streamId: "thr_1",
      workspaceId: WORKSPACE_ID,
      status: "active",
      confidence: 1,
    })
    expect(spies.insert.mock.calls[0][1].topicSummary).toBeUndefined()

    const newId = spies.insert.mock.calls[0][1].id as string
    // The move set is the thread's own messages plus the descendant thread's.
    expect(spies.addPrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      newId,
      ["msg_t1", "msg_t2", "msg_t2sub"],
      ["usr_1", "usr_2"]
    )
    // Source loses exactly the moved ids; participants recomputed from the rest.
    expect(spies.removePrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      "conv_src",
      ["msg_t1", "msg_t2", "msg_t2sub"],
      ["usr_1", "usr_2"]
    )
    expect(spies.bumpActivityForIds).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, ["conv_src", newId])

    expect(result.conversation.streamId).toBe("thr_1")
    // Source keeps its opener (stays a real card, still active).
    expect(result.sourceConversation.messageIds).toEqual(["msg_open", "msg_root2"])
    expect(result.sourceConversation.status).toBe("active")
  })

  test("writes a conversation_feedback row per moved message (from source → new)", async () => {
    const spies = setup()

    await split()

    expect(spies.feedbackInsertMany).toHaveBeenCalledTimes(1)
    const rows = spies.feedbackInsertMany.mock.calls[0][1] as Array<Record<string, unknown>>
    expect(rows.map((r) => r.messageId)).toEqual(["msg_t1", "msg_t2", "msg_t2sub"])
    expect(rows.every((r) => r.fromConversationId === "conv_src" && r.userId === ACTOR_ID)).toBe(true)
    // Each row records the message's own stream (the thread / sub-thread).
    expect(rows.map((r) => r.streamId)).toEqual(["thr_1", "thr_1", "thr_2"])
  })

  test("emits conversation:created, conversation:updated, and per-message reassigned events (by content)", async () => {
    const spies = setup()

    await split()

    type Event = { type: string; payload: Record<string, any> }
    const events: Event[] = spies.outboxInsert.mock.calls.map((c: unknown[]) => ({
      type: c[1] as string,
      payload: c[2] as Record<string, any>,
    }))
    const created = events.find((e: Event) => e.type === "conversation:created")
    expect(created?.payload.conversation.streamId).toBe("thr_1")
    const updated = events.find((e: Event) => e.type === "conversation:updated")
    expect(updated?.payload.conversationId).toBe("conv_src")
    // One move event per moved message, routed to the message's own stream.
    const reassigned = events.filter((e: Event) => e.type === "conversation:message_reassigned")
    expect(reassigned.map((e: Event) => e.payload.messageId).sort()).toEqual(["msg_t1", "msg_t2", "msg_t2sub"])
    expect(
      reassigned.every(
        (e: Event) => e.payload.fromConversationId === "conv_src" && e.payload.reason === "user_correction"
      )
    ).toBe(true)
  })

  test("rejects a thread in a different root stream (same-root guard, 400)", async () => {
    setup()
    await expect(split("thr_foreign")).rejects.toMatchObject({ code: "CONVERSATION_NOT_IN_ROOT", status: 400 })
  })

  test("rejects when the thread's fork message is not a member of the conversation (400)", async () => {
    // Source doesn't own `msg_open` (thr_1's parent message) as a member.
    setup({ source: makeConversation({ messageIds: ["msg_root2", "msg_t1", "msg_t2"] }) })
    await expect(split("thr_1")).rejects.toMatchObject({ code: "FORK_MESSAGE_NOT_MEMBER", status: 400 })
  })

  test("rejects when the thread has no member messages to move (empty set, 400)", async () => {
    // Source's only members sit in the root — none in thr_1's subtree.
    setup({ source: makeConversation({ messageIds: ["msg_open", "msg_root2"] }) })
    await expect(split("thr_1")).rejects.toMatchObject({ code: "NO_THREAD_MEMBERS", status: 400 })
  })

  test("rejects a split target that is not a thread (400)", async () => {
    setup()
    await expect(split("chan_1")).rejects.toMatchObject({ code: "NOT_A_THREAD", status: 400 })
  })
})
