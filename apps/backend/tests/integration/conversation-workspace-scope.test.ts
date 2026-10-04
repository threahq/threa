import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes, ConversationStatuses, StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"
import { ConversationRepository } from "../../src/features/conversations"
import { MessageConversationStateRepository } from "../../src/features/conversations/settling-repository"
import { MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { conversationId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("Conversation settling workspace scope (INV-8)", () => {
  let pool: Pool

  let wsA: string
  let wsB: string
  let authorA: string
  let authorB: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Conversation scope ${label}`,
        slug: `conversation-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    return id
  }

  async function seedMember(wid: string) {
    return withTransaction(pool, async (client) => (await addTestMember(client, wid, userId())).id)
  }

  async function seedStream(wid: string, createdBy: string) {
    const id = streamId()
    await StreamRepository.insert(pool, {
      id,
      workspaceId: wid,
      type: StreamTypes.CHANNEL,
      slug: `conversation-scope-${id}`,
      visibility: Visibilities.PUBLIC,
      createdBy,
    })
    return id
  }

  async function seedMessage(wid: string, stream: string, author: string, sequence: number) {
    const id = messageId()
    await MessageRepository.insert(pool, {
      workspaceId: wid,
      id,
      streamId: stream,
      sequence: BigInt(sequence),
      authorId: author,
      authorType: AuthorTypes.USER,
      ...testMessageContent(`message ${sequence}`),
    })
    return id
  }

  async function seedConversation(wid: string, stream: string) {
    const id = conversationId()
    await ConversationRepository.insert(pool, {
      id,
      streamId: stream,
      workspaceId: wid,
      topicSummary: "Scope fixture",
      status: ConversationStatuses.ACTIVE,
    })
    return id
  }

  async function seedSettling(wid: string, stream: string, conversation: string, message: string) {
    await MessageConversationStateRepository.insertSettling(pool, {
      messageId: message,
      workspaceId: wid,
      streamId: stream,
      conversationId: conversation,
    })
  }

  async function storedStates(messageIds: string[]) {
    const result = await pool.query(
      `SELECT message_id, workspace_id, stream_id, conversation_id, state, settled_by
       FROM message_conversation_state WHERE message_id = ANY($1::text[])`,
      [messageIds]
    )
    return Object.fromEntries(
      result.rows.map((row) => [
        row.message_id,
        {
          workspaceId: row.workspace_id,
          streamId: row.stream_id,
          conversationId: row.conversation_id,
          state: row.state,
          settledBy: row.settled_by,
        },
      ])
    )
  }

  // NOW() reaches JS as a millisecond Date, so a row created earlier in the same
  // millisecond would compare as not before it; one more millisecond keeps it in.
  const passStart = async () => new Date((await MessageConversationStateRepository.now(pool)).getTime() + 1)

  beforeAll(async () => {
    pool = await setupTestDatabase()

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    authorA = await seedMember(wsA)
    authorB = await seedMember(wsB)
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should floor the settle window on its own workspace's messages when settling outside the window", async () => {
    const stream = await seedStream(wsA, authorA)
    const conversation = await seedConversation(wsA, stream)
    const first = await seedMessage(wsA, stream, authorA, 1)
    const second = await seedMessage(wsA, stream, authorA, 2)
    const keep = await seedMessage(wsA, stream, authorA, 3)
    const foreignFloor = await seedMessage(wsB, stream, authorB, 0)
    await seedSettling(wsA, stream, conversation, first)
    await seedSettling(wsA, stream, conversation, second)

    const settled = await MessageConversationStateRepository.settleStreamOutsideWindow(
      pool,
      wsA,
      stream,
      [keep, foreignFloor],
      "llm-window",
      await passStart()
    )

    expect({
      settled: settled.map((row) => row.messageId).sort(),
      stored: await storedStates([first, second]),
    }).toEqual({
      settled: [first, second].sort(),
      stored: {
        [first]: expect.objectContaining({ workspaceId: wsA, state: "settled", settledBy: "llm-window" }),
        [second]: expect.objectContaining({ workspaceId: wsA, state: "settled", settledBy: "llm-window" }),
      },
    })
  })

  test("should settle only its own workspace's rows when settling outside the window", async () => {
    const stream = await seedStream(wsA, authorA)
    const conversation = await seedConversation(wsA, stream)
    const own = await seedMessage(wsA, stream, authorA, 1)
    const foreignRow = await seedMessage(wsB, stream, authorB, 2)
    const foreignMessageInStream = await seedMessage(wsB, stream, authorB, 3)
    const ownMessageForeignRow = await seedMessage(wsA, stream, authorA, 4)
    const keep = await seedMessage(wsA, stream, authorA, 5)
    await seedSettling(wsA, stream, conversation, own)
    await seedSettling(wsB, stream, conversationId(), foreignRow)
    await seedSettling(wsA, stream, conversation, foreignMessageInStream)
    await seedSettling(wsB, stream, conversation, ownMessageForeignRow)

    const settled = await MessageConversationStateRepository.settleStreamOutsideWindow(
      pool,
      wsA,
      stream,
      [keep],
      "llm-window",
      await passStart()
    )

    expect({
      settled: settled.map((row) => row.messageId),
      stored: await storedStates([own, foreignRow, foreignMessageInStream, ownMessageForeignRow]),
    }).toEqual({
      settled: [own],
      stored: {
        [own]: expect.objectContaining({ workspaceId: wsA, state: "settled" }),
        [foreignRow]: expect.objectContaining({ workspaceId: wsB, state: "settling" }),
        [foreignMessageInStream]: expect.objectContaining({ workspaceId: wsA, state: "settling" }),
        [ownMessageForeignRow]: expect.objectContaining({ workspaceId: wsB, state: "settling" }),
      },
    })
  })

  test("should land the placement beside another workspace's state row when a user placement shares its message id", async () => {
    const stream = await seedStream(wsA, authorA)
    const conversation = await seedConversation(wsA, stream)
    const foreignOwner = conversationId()
    const own = await seedMessage(wsA, stream, authorA, 1)
    await seedSettling(wsB, stream, foreignOwner, own)

    const settled = await MessageConversationStateRepository.settleForConversationTargets(
      pool,
      wsA,
      [own],
      conversation,
      "user"
    )

    expect({
      settled: settled.map((row) => row.messageId),
      a: await MessageConversationStateRepository.findByMessageId(pool, wsA, own),
      b: await MessageConversationStateRepository.findByMessageId(pool, wsB, own),
    }).toEqual({
      settled: [own],
      a: expect.objectContaining({
        workspaceId: wsA,
        conversationId: conversation,
        state: "settled",
        settledBy: "user",
      }),
      b: expect.objectContaining({ workspaceId: wsB, conversationId: foreignOwner, state: "settling" }),
    })
  })
})
