import { afterEach, describe, expect, spyOn, mock, test } from "bun:test"
import type { PoolClient } from "pg"
import { ConversationService, type ApplySplitGroup } from "./service"
import { ConversationRepository, type Conversation } from "./repository"
import { ConversationFeedbackRepository } from "./feedback-repository"
import * as delivery from "./conversation-delivery"
import { StreamRepository } from "../streams"
import * as streamsModule from "../streams"
import { MessageRepository, type Message } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const ACTOR_ID = "usr_1"

// The conversation under split lives in chan_1; `m_foreign` is the cross-stream case.
const MESSAGES: Record<string, { streamId: string; authorId: string; sequence: number }> = {
  m1: { streamId: "chan_1", authorId: "usr_1", sequence: 1 },
  m2: { streamId: "chan_1", authorId: "usr_2", sequence: 2 },
  m3: { streamId: "chan_1", authorId: "usr_1", sequence: 3 },
  m4: { streamId: "chan_1", authorId: "usr_2", sequence: 4 },
  m_foreign: { streamId: "chan_2", authorId: "usr_1", sequence: 5 },
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_a",
    streamId: "chan_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["m1", "m2", "m3", "m4"],
    participantIds: ["usr_1", "usr_2"],
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

function message(id: string): Message {
  const base = MESSAGES[id]
  return { id, streamId: base.streamId, authorId: base.authorId, sequence: base.sequence } as unknown as Message
}

interface Spies {
  insert: ReturnType<typeof spyOn>
  update: ReturnType<typeof spyOn>
  updateTopicSummary: ReturnType<typeof spyOn>
  removePrimaryMessages: ReturnType<typeof spyOn>
  addPrimaryMessages: ReturnType<typeof spyOn>
  resolveIfEmpty: ReturnType<typeof spyOn>
  bumpActivityForIds: ReturnType<typeof spyOn>
  feedbackInsertMany: ReturnType<typeof spyOn>
  outboxInsert: ReturnType<typeof spyOn>
}

/**
 * @param source The conversation being split (its `messageIds` are the members).
 * @param primaries messageId → current primary conversation id (authoritative membership).
 */
function setup(options: { source: Conversation; primaries: Record<string, string> }): Spies {
  const created: Record<string, Conversation> = { [options.source.id]: options.source }
  const fakeClient = { query: mock(async () => ({ rows: [] })) } as unknown as PoolClient
  spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withTransaction)
  spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({} as never)

  spyOn(StreamRepository, "findById").mockResolvedValue({ id: "chan_1", type: "channel" } as never)

  spyOn(ConversationRepository, "findByIdForUpdate").mockImplementation(
    async (_c: unknown, _ws: string, id: string) => created[id] ?? null
  )
  spyOn(ConversationRepository, "findPrimariesByMessageIds").mockImplementation(async (_c, _ws, ids: string[]) => {
    const map = new Map<string, Conversation>()
    for (const id of ids) {
      const convId = options.primaries[id]
      if (convId) map.set(id, created[convId] ?? makeConversation({ id: convId }))
    }
    return map
  })
  spyOn(ConversationRepository, "findByIds").mockImplementation(async (_c, _ws, ids: string[]) =>
    ids.map((id) => created[id]).filter((c): c is Conversation => c !== undefined)
  )

  const insert = spyOn(ConversationRepository, "insert").mockImplementation(async (_c, params) => {
    const conv = makeConversation({
      id: params.id,
      streamId: params.streamId,
      topicSummary: params.topicSummary ?? null,
      summary: params.summary ?? null,
      messageIds: [],
      participantIds: [],
    })
    created[params.id] = conv
    return conv
  })

  spyOn(MessageRepository, "findByIdsForUpdate").mockImplementation(async (_c, ids: string[]) =>
    ids
      .filter((id) => MESSAGES[id])
      .map(message)
      .sort((a, b) => (a as unknown as { sequence: number }).sequence - (b as unknown as { sequence: number }).sequence)
  )
  spyOn(MessageRepository, "findByIds").mockImplementation(
    async (_c, ids: string[]) => new Map(ids.filter((id) => MESSAGES[id]).map((id) => [id, message(id)]))
  )

  spyOn(delivery, "resolveConversationDelivery").mockResolvedValue({
    parentStreamId: "chan_1",
    streamVisibility: "public",
  })

  return {
    insert,
    update: spyOn(ConversationRepository, "update").mockResolvedValue(null as never),
    updateTopicSummary: spyOn(ConversationRepository, "updateTopicSummary").mockImplementation(async (_db, params) =>
      makeConversation({ id: params.conversationId, topicSummary: params.topicSummary })
    ),
    removePrimaryMessages: spyOn(ConversationRepository, "removePrimaryMessages").mockResolvedValue(undefined as never),
    addPrimaryMessages: spyOn(ConversationRepository, "addPrimaryMessages").mockResolvedValue(undefined as never),
    resolveIfEmpty: spyOn(ConversationRepository, "resolveIfEmpty").mockResolvedValue(undefined as never),
    bumpActivityForIds: spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never),
    feedbackInsertMany: spyOn(ConversationFeedbackRepository, "insertMany").mockResolvedValue(undefined as never),
    outboxInsert: spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never),
  }
}

function applySplit(conversationId: string, groups: ApplySplitGroup[]) {
  return new ConversationService({} as never).applySplit({
    workspaceId: WORKSPACE_ID,
    streamId: "chan_1",
    conversationId,
    groups,
    actorUserId: ACTOR_ID,
  })
}

type Event = { type: string; payload: Record<string, any> }
function events(outboxInsert: ReturnType<typeof spyOn>): Event[] {
  return outboxInsert.mock.calls.map((c: unknown[]) => ({ type: c[1] as string, payload: c[2] as Record<string, any> }))
}

describe("ConversationService.applySplit", () => {
  afterEach(() => mock.restore())

  test("keeps the first group in the source (re-titled) and mints the rest", async () => {
    const spies = setup({
      source: makeConversation(),
      primaries: { m1: "conv_a", m2: "conv_a", m3: "conv_a", m4: "conv_a" },
    })

    const result = await applySplit("conv_a", [
      { title: "Fable pricing", messageIds: ["m1", "m2"] },
      { title: "Fable på svenska", summary: "Om Fable och svenska", messageIds: ["m3", "m4"] },
    ])

    // Source re-titled to the kept (first) group; only the moved ids are stripped.
    expect(spies.updateTopicSummary).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WORKSPACE_ID,
      conversationId: "conv_a",
      topicSummary: "Fable pricing",
      source: "explicit",
      updatedByUserId: ACTOR_ID,
    })
    expect(spies.update).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, "conv_a", { summary: undefined })
    expect(spies.removePrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      "conv_a",
      ["m3", "m4"],
      ["usr_1", "usr_2"]
    )

    // One mint, titled, carrying the second group's messages.
    expect(spies.insert).toHaveBeenCalledTimes(1)
    expect(spies.insert.mock.calls[0][1]).toMatchObject({
      streamId: "chan_1",
      topicSummary: "Fable på svenska",
      summary: "Om Fable och svenska",
    })
    const mintedId = spies.insert.mock.calls[0][1].id as string
    expect(spies.addPrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      mintedId,
      ["m3", "m4"],
      ["usr_1", "usr_2"]
    )

    expect(result.conversation.id).toBe("conv_a")
    expect(result.newConversations.map((c) => c.id)).toEqual([mintedId])
  })

  test("writes one feedback row per moved message and the expected outbox events", async () => {
    const spies = setup({
      source: makeConversation(),
      primaries: { m1: "conv_a", m2: "conv_a", m3: "conv_a", m4: "conv_a" },
    })

    await applySplit("conv_a", [
      { title: "Keep", messageIds: ["m1", "m2"] },
      { title: "A", messageIds: ["m3"] },
      { title: "B", messageIds: ["m4"] },
    ])

    // Only moved messages get feedback rows, each recording the source it left.
    const rows = spies.feedbackInsertMany.mock.calls[0][1] as Array<Record<string, unknown>>
    expect(rows.map((r) => r.messageId).sort()).toEqual(["m3", "m4"])
    expect(rows.every((r) => r.fromConversationId === "conv_a" && r.userId === ACTOR_ID)).toBe(true)

    const evs = events(spies.outboxInsert)
    // Two mints → two conversation:created; one conversation:updated for the source.
    expect(evs.filter((e) => e.type === "conversation:created")).toHaveLength(2)
    expect(evs.filter((e) => e.type === "conversation:updated").map((e) => e.payload.conversationId)).toEqual([
      "conv_a",
    ])
    expect(
      evs
        .filter((e) => e.type === "conversation:message_reassigned")
        .map((e) => e.payload.messageId)
        .sort()
    ).toEqual(["m3", "m4"])
  })

  test("re-titles the source when the split covered the whole conversation", async () => {
    const spies = setup({
      source: makeConversation(),
      primaries: { m1: "conv_a", m2: "conv_a", m3: "conv_a", m4: "conv_a" },
    })

    await applySplit("conv_a", [
      { title: "Kept", messageIds: ["m1", "m2"] },
      { title: "Moved", messageIds: ["m3", "m4"] },
    ])

    expect(spies.updateTopicSummary).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WORKSPACE_ID,
      conversationId: "conv_a",
      topicSummary: "Kept",
      source: "explicit",
      updatedByUserId: ACTOR_ID,
    })
    expect(spies.update).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, "conv_a", { summary: undefined })
  })

  test("leaves the source title untouched when un-analyzed messages remain", async () => {
    // m4 stays in the source but isn't in any proposed group (older than the split
    // window / arrived after the proposal) — the kept group's title would misdescribe
    // it, so the source keeps its existing title.
    const spies = setup({
      source: makeConversation({ messageIds: ["m1", "m2", "m3", "m4"] }),
      primaries: { m1: "conv_a", m2: "conv_a", m3: "conv_a", m4: "conv_a" },
    })

    await applySplit("conv_a", [
      { title: "Kept", messageIds: ["m1", "m2"] },
      { title: "Moved", messageIds: ["m3"] },
    ])

    // m3 still moves out into a new conversation…
    expect(spies.insert).toHaveBeenCalledTimes(1)
    expect(spies.addPrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      expect.any(String),
      ["m3"],
      ["usr_1"]
    )
    // …but the source is NOT re-titled (m4 was never analyzed).
    expect(spies.update).not.toHaveBeenCalled()
  })

  test("skips a message that raced out of the source between propose and apply", async () => {
    const spies = setup({
      source: makeConversation({ messageIds: ["m1", "m2", "m3"] }),
      // m4 was proposed to move but now lives elsewhere; m3 is still in the source.
      primaries: { m1: "conv_a", m2: "conv_a", m3: "conv_a", m4: "conv_raced" },
    })

    await applySplit("conv_a", [
      { title: "Keep", messageIds: ["m1", "m2"] },
      { title: "Moved", messageIds: ["m3", "m4"] },
    ])

    // Only m3 actually moves; m4 is left where it now lives.
    expect(spies.addPrimaryMessages.mock.calls[0][3]).toEqual(["m3"])
    expect(spies.removePrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      "conv_a",
      ["m3"],
      ["usr_1", "usr_2"]
    )
  })

  test("rejects with 409 when every moved message raced away", async () => {
    const spies = setup({
      source: makeConversation({ messageIds: ["m1", "m2"] }),
      primaries: { m1: "conv_a", m2: "conv_a", m3: "conv_raced" },
    })

    await expect(
      applySplit("conv_a", [
        { title: "Keep", messageIds: ["m1", "m2"] },
        { title: "Gone", messageIds: ["m3"] },
      ])
    ).rejects.toMatchObject({ code: "NO_MESSAGES_TO_MOVE", status: 409 })
    expect(spies.insert).not.toHaveBeenCalled()
    expect(spies.outboxInsert).not.toHaveBeenCalled()
  })

  test("rejects a group message from another stream (400)", async () => {
    setup({
      source: makeConversation({ messageIds: ["m1", "m2", "m_foreign"] }),
      primaries: { m1: "conv_a", m2: "conv_a", m_foreign: "conv_a" },
    })
    await expect(
      applySplit("conv_a", [
        { title: "Keep", messageIds: ["m1"] },
        { title: "Foreign", messageIds: ["m2", "m_foreign"] },
      ])
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_IN_STREAM", status: 400 })
  })
})
