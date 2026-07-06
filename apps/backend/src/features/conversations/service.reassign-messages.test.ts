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

// Every message lives in chan_1; `m_foreign` is the cross-stream negative case.
const MESSAGES: Record<string, { streamId: string; authorId: string; sequence: number }> = {
  m1: { streamId: "chan_1", authorId: "usr_1", sequence: 1 },
  m2: { streamId: "chan_1", authorId: "usr_2", sequence: 2 },
  m3: { streamId: "chan_1", authorId: "usr_1", sequence: 3 },
  m4: { streamId: "chan_1", authorId: "usr_2", sequence: 4 },
  m_other: { streamId: "chan_1", authorId: "usr_3", sequence: 5 },
  m_foreign: { streamId: "chan_2", authorId: "usr_1", sequence: 6 },
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

function messageMap(ids: string[]): Map<string, Message> {
  return new Map(ids.map((id) => [id, message(id)]))
}

interface Spies {
  insert: ReturnType<typeof spyOn>
  removePrimaryMessages: ReturnType<typeof spyOn>
  addPrimaryMessages: ReturnType<typeof spyOn>
  resolveIfEmpty: ReturnType<typeof spyOn>
  reactivateIfInactive: ReturnType<typeof spyOn>
  bumpActivityForIds: ReturnType<typeof spyOn>
  feedbackInsertMany: ReturnType<typeof spyOn>
  outboxInsert: ReturnType<typeof spyOn>
}

/**
 * @param conversations Every conversation the batch touches, keyed by id. The
 *   source(s) selected messages leave, plus any existing destination.
 * @param primaries messageId → current primary conversation id.
 */
function setup(options: {
  conversations: Record<string, Conversation>
  primaries: Record<string, string>
  /** Membership returned by the authoritative (2nd) read, if it differs (a race). */
  authoritativePrimaries?: Record<string, string>
  existingTargetId?: string
}): Spies {
  const fakeClient = { query: mock(async () => ({ rows: [] })) } as unknown as PoolClient
  spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withTransaction)

  spyOn(StreamRepository, "findById").mockResolvedValue({ id: "chan_1", type: "channel" } as never)

  spyOn(ConversationRepository, "findByIdForUpdate").mockImplementation(
    async (_c: unknown, _ws: string, id: string) => options.conversations[id] ?? null
  )
  // Two calls happen: an unlocked peek, then the authoritative re-read once
  // messages are pinned. `authoritativePrimaries`, when set, models a race by
  // returning different membership on the second (authoritative) call.
  let primariesCall = 0
  spyOn(ConversationRepository, "findPrimariesByMessageIds").mockImplementation(async (_c, _ws, ids: string[]) => {
    primariesCall++
    const table =
      options.authoritativePrimaries && primariesCall >= 2 ? options.authoritativePrimaries : options.primaries
    const map = new Map<string, Conversation>()
    for (const id of ids) {
      const convId = table[id]
      // A conversation the peek never saw isn't in `conversations`, so it's never
      // locked — exactly the "raced into an un-pre-locked conversation" case.
      if (convId && options.conversations[convId]) map.set(id, options.conversations[convId])
      else if (convId) map.set(id, makeConversation({ id: convId, streamId: "chan_1" }))
    }
    return map
  })
  // Post-write re-read: return the touched rows by id (membership doesn't need to
  // reflect the writes for these assertions — we assert on the mutating calls).
  spyOn(ConversationRepository, "findByIds").mockImplementation(async (_c, _ws, ids: string[]) =>
    ids.map((id) => options.conversations[id]).filter((c): c is Conversation => c !== undefined)
  )
  spyOn(ConversationRepository, "findById").mockImplementation(
    async (_c: unknown, id: string) => options.conversations[id] ?? null
  )

  const insert = spyOn(ConversationRepository, "insert").mockImplementation(async (_c, params) => {
    const created = makeConversation({
      id: params.id,
      streamId: params.streamId,
      topicSummary: null,
      messageIds: [],
      participantIds: [],
    })
    options.conversations[params.id] = created
    return created
  })

  spyOn(MessageRepository, "findByIdsForUpdate").mockImplementation(async (_c, ids: string[]) =>
    ids
      .filter((id) => MESSAGES[id])
      .map(message)
      .sort((a, b) => (a as unknown as { sequence: number }).sequence - (b as unknown as { sequence: number }).sequence)
  )
  spyOn(MessageRepository, "findByIds").mockImplementation(async (_c, ids: string[]) =>
    messageMap(ids.filter((id) => MESSAGES[id]))
  )

  spyOn(delivery, "resolveConversationDelivery").mockResolvedValue({
    parentStreamId: "chan_1",
    streamVisibility: "public",
  })

  return {
    insert,
    removePrimaryMessages: spyOn(ConversationRepository, "removePrimaryMessages").mockResolvedValue(undefined as never),
    addPrimaryMessages: spyOn(ConversationRepository, "addPrimaryMessages").mockResolvedValue(undefined as never),
    resolveIfEmpty: spyOn(ConversationRepository, "resolveIfEmpty").mockResolvedValue(undefined as never),
    reactivateIfInactive: spyOn(ConversationRepository, "reactivateIfInactive").mockResolvedValue(undefined as never),
    bumpActivityForIds: spyOn(ConversationRepository, "bumpActivityForIds").mockResolvedValue(undefined as never),
    feedbackInsertMany: spyOn(ConversationFeedbackRepository, "insertMany").mockResolvedValue(undefined as never),
    outboxInsert: spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never),
  }
}

function service(): ConversationService {
  return new ConversationService({} as never)
}

function reassign(messageIds: string[], target: { kind: "existing"; conversationId: string } | { kind: "new" }) {
  return service().reassignMessagesToConversation({
    workspaceId: WORKSPACE_ID,
    streamId: "chan_1",
    messageIds,
    target,
    actorUserId: ACTOR_ID,
  })
}

type Event = { type: string; payload: Record<string, any> }
function events(outboxInsert: ReturnType<typeof spyOn>): Event[] {
  return outboxInsert.mock.calls.map((c: unknown[]) => ({
    type: c[1] as string,
    payload: c[2] as Record<string, any>,
  }))
}

describe("ConversationService.reassignMessagesToConversation", () => {
  afterEach(() => mock.restore())

  test("splits selected messages into a freshly minted conversation", async () => {
    const spies = setup({
      conversations: { conv_a: makeConversation() },
      primaries: { m2: "conv_a", m3: "conv_a" },
    })

    const result = await reassign(["m2", "m3"], { kind: "new" })

    // Minted anchored to the stream, no copied title (fresh-mint precedent).
    expect(spies.insert).toHaveBeenCalledTimes(1)
    expect(spies.insert.mock.calls[0][1]).toMatchObject({ streamId: "chan_1", workspaceId: WORKSPACE_ID })
    expect(spies.insert.mock.calls[0][1].topicSummary).toBeUndefined()
    const newId = spies.insert.mock.calls[0][1].id as string

    // Move set added to the new conversation, in sequence order, authors deduped.
    expect(spies.addPrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      newId,
      ["m2", "m3"],
      ["usr_2", "usr_1"]
    )
    // Source loses exactly the moved ids; participants recomputed from the rest.
    expect(spies.removePrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      "conv_a",
      ["m2", "m3"],
      ["usr_1", "usr_2"]
    )
    expect(result.conversation.id).toBe(newId)
    expect(result.sourceConversations.map((c) => c.id)).toEqual(["conv_a"])
  })

  test("reassigns selected messages into an existing conversation, unioning participants", async () => {
    const target = makeConversation({
      id: "conv_b",
      topicSummary: "Roadmap",
      messageIds: ["m_other"],
      participantIds: ["usr_3"],
    })
    const spies = setup({
      conversations: { conv_a: makeConversation(), conv_b: target },
      primaries: { m2: "conv_a" },
    })

    await reassign(["m2"], { kind: "existing", conversationId: "conv_b" })

    expect(spies.insert).not.toHaveBeenCalled()
    // Existing member's author (usr_3) preserved alongside the arrival (usr_2).
    expect(spies.addPrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      "conv_b",
      ["m2"],
      ["usr_3", "usr_2"]
    )
  })

  test("writes one feedback row per moved message and per-message reassigned events", async () => {
    const spies = setup({
      conversations: { conv_a: makeConversation() },
      primaries: { m2: "conv_a", m3: "conv_a" },
    })

    await reassign(["m2", "m3"], { kind: "new" })

    const rows = spies.feedbackInsertMany.mock.calls[0][1] as Array<Record<string, unknown>>
    expect(rows.map((r) => r.messageId)).toEqual(["m2", "m3"])
    expect(rows.every((r) => r.fromConversationId === "conv_a" && r.userId === ACTOR_ID)).toBe(true)

    const reassigned = events(spies.outboxInsert).filter((e) => e.type === "conversation:message_reassigned")
    expect(reassigned.map((e) => e.payload.messageId)).toEqual(["m2", "m3"])
    expect(events(spies.outboxInsert).some((e) => e.type === "conversation:created")).toBe(true)
  })

  test("handles a selection spanning two source conversations", async () => {
    const convA = makeConversation({ id: "conv_a", messageIds: ["m1", "m2"], participantIds: ["usr_1", "usr_2"] })
    const convB = makeConversation({ id: "conv_b", messageIds: ["m3", "m4"], participantIds: ["usr_1", "usr_2"] })
    const spies = setup({
      conversations: { conv_a: convA, conv_b: convB },
      primaries: { m2: "conv_a", m3: "conv_b" },
    })

    const result = await reassign(["m2", "m3"], { kind: "new" })

    // Each source loses only its own contributed id.
    expect(spies.removePrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      "conv_a",
      ["m2"],
      ["usr_1"]
    )
    expect(spies.removePrimaryMessages).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      "conv_b",
      ["m3"],
      ["usr_2"]
    )
    expect(result.sourceConversations.map((c) => c.id).sort()).toEqual(["conv_a", "conv_b"])
  })

  test("is a no-op when every selected message already lives in the destination", async () => {
    const target = makeConversation({ id: "conv_b", messageIds: ["m2"], participantIds: ["usr_2"] })
    const spies = setup({
      conversations: { conv_b: target },
      primaries: { m2: "conv_b" },
    })

    const result = await reassign(["m2"], { kind: "existing", conversationId: "conv_b" })

    expect(spies.addPrimaryMessages).not.toHaveBeenCalled()
    expect(spies.removePrimaryMessages).not.toHaveBeenCalled()
    expect(spies.outboxInsert).not.toHaveBeenCalled()
    expect(result.sourceConversations).toEqual([])
  })

  test("mints no orphan conversation when a new-target selection all races away", async () => {
    // Peek sees m2 in conv_a; by the authoritative re-read a concurrent op has
    // moved it into conv_raced, which was never peeked (so never locked).
    const spies = setup({
      conversations: { conv_a: makeConversation() },
      primaries: { m2: "conv_a" },
      authoritativePrimaries: { m2: "conv_raced" },
    })

    await expect(reassign(["m2"], { kind: "new" })).rejects.toMatchObject({
      code: "NO_MESSAGES_TO_MOVE",
      status: 409,
    })
    // The mint is deferred past the no-op check, so nothing was inserted.
    expect(spies.insert).not.toHaveBeenCalled()
    expect(spies.addPrimaryMessages).not.toHaveBeenCalled()
    expect(spies.outboxInsert).not.toHaveBeenCalled()
  })

  test("rejects a selection with a message from another stream (400)", async () => {
    setup({ conversations: { conv_a: makeConversation() }, primaries: { m2: "conv_a" } })
    await expect(reassign(["m2", "m_foreign"], { kind: "new" })).rejects.toMatchObject({
      code: "MESSAGE_NOT_IN_STREAM",
      status: 400,
    })
  })

  test("rejects an existing target in a different stream (400)", async () => {
    const target = makeConversation({ id: "conv_b", streamId: "chan_2" })
    setup({ conversations: { conv_a: makeConversation(), conv_b: target }, primaries: { m2: "conv_a" } })
    await expect(reassign(["m2"], { kind: "existing", conversationId: "conv_b" })).rejects.toMatchObject({
      code: "CONVERSATION_NOT_IN_STREAM",
      status: 400,
    })
  })

  test("rejects when a selected message does not exist (404)", async () => {
    setup({ conversations: { conv_a: makeConversation() }, primaries: {} })
    await expect(reassign(["m2", "does_not_exist"], { kind: "new" })).rejects.toMatchObject({
      code: "MESSAGE_NOT_FOUND",
      status: 404,
    })
  })
})
