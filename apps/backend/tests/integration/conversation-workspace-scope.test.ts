import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  ActivityTypes,
  AuthorTypes,
  ConversationStatuses,
  LabelableResourceTypes,
  StreamTypes,
  TitleSources,
  Visibilities,
  type ConversationStatus,
} from "@threahq/types"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"
import {
  BoundaryExtractionService,
  ConversationRepository,
  ConversationService,
  StubBoundaryExtractor,
} from "../../src/features/conversations"
import { plan } from "../../src/features/conversations/embedding-backfill"
import { MessageConversationStateRepository } from "../../src/features/conversations/settling-repository"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  activityId,
  conversationId,
  labelId,
  messageId,
  streamId,
  userEncryptionKeyId,
  userId,
  workspaceId,
} from "../../src/lib/id"

const UNIT_EMBEDDING = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))

describe("Conversation, settling and embedding backfill workspace scope (INV-8)", () => {
  let pool: Pool
  let service: ConversationService

  let wsA: string
  let wsB: string
  let authorA: string
  let authorB: string
  let viewerA: string

  let channelA: string
  let channelB: string
  let threadA: string
  let threadB: string
  let crossRootThread: string
  let mentionChannel: string

  let convA1: string
  let convA2: string
  let convAThread: string
  let convBInChannelA: string
  let convAInThreadB: string
  let convACrossRoot: string
  let convMention: string
  let foreignMessage: string
  let foreignSecondary: string
  let foreignFilled: string
  let foreignEmpty: string
  let foreignResolved: string
  let boardLabel: string

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

  async function seedStream(
    wid: string,
    createdBy: string,
    placement: { type?: "channel" | "thread"; parentStreamId?: string; rootStreamId?: string } = {}
  ) {
    const id = streamId()
    await StreamRepository.insert(pool, {
      id,
      workspaceId: wid,
      type: placement.type ?? StreamTypes.CHANNEL,
      slug: placement.type === StreamTypes.THREAD ? undefined : `conversation-scope-${id}`,
      visibility: Visibilities.PUBLIC,
      parentStreamId: placement.parentStreamId,
      rootStreamId: placement.rootStreamId,
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

  async function seedConversation(
    wid: string,
    stream: string,
    options: { status?: ConversationStatus; primaryMessage?: { id: string; author: string } } = {}
  ) {
    const id = conversationId()
    await ConversationRepository.insert(pool, {
      id,
      streamId: stream,
      workspaceId: wid,
      topicSummary: "Scope fixture",
      status: options.status ?? ConversationStatuses.ACTIVE,
    })
    if (options.primaryMessage) {
      await ConversationRepository.addPrimaryMessages(
        pool,
        wid,
        id,
        [options.primaryMessage.id],
        [options.primaryMessage.author]
      )
    }
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

  async function storedConversations(conversationIds: string[]) {
    const result = await pool.query("SELECT * FROM conversations WHERE id = ANY($1::text[]) ORDER BY id", [
      conversationIds,
    ])
    return result.rows
  }

  async function boardFeedIds(options?: Parameters<typeof ConversationRepository.findByWorkspaceForViewer>[3]) {
    const feed = await ConversationRepository.findByWorkspaceForViewer(pool, wsA, viewerA, { ...options, limit: 200 })
    const seeded = [convAThread, convMention, convBInChannelA, convAInThreadB, convACrossRoot]
    return ids(feed.filter((conversation) => seeded.includes(conversation.id)))
  }

  const ids = (conversations: Array<{ id: string }>) => conversations.map((conversation) => conversation.id).sort()

  // NOW() reaches JS as a millisecond Date, so a row created earlier in the same
  // millisecond would compare as not before it; one more millisecond keeps it in.
  const passStart = async () => new Date((await MessageConversationStateRepository.now(pool)).getTime() + 1)

  /**
   * A stream holding A's settling row for one message plus B's settling row for a
   * message of B's that points at A's conversation and stream.
   */
  async function seedSettlingPair() {
    const stream = await seedStream(wsA, authorA)
    const conversation = await seedConversation(wsA, stream)
    const own = await seedMessage(wsA, stream, authorA, 1)
    const foreign = await seedMessage(wsB, stream, authorB, 2)
    await seedSettling(wsA, stream, conversation, own)
    await seedSettling(wsB, stream, conversation, foreign)
    return { stream, conversation, own, foreign }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new ConversationService(pool)

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    authorA = await seedMember(wsA)
    authorB = await seedMember(wsB)
    viewerA = await seedMember(wsA)

    channelA = await seedStream(wsA, authorA)
    channelB = await seedStream(wsB, authorB)
    threadA = await seedStream(wsA, authorA, {
      type: StreamTypes.THREAD,
      parentStreamId: channelA,
      rootStreamId: channelA,
    })
    threadB = await seedStream(wsB, authorB, {
      type: StreamTypes.THREAD,
      parentStreamId: channelA,
      rootStreamId: channelA,
    })
    crossRootThread = await seedStream(wsA, authorA, {
      type: StreamTypes.THREAD,
      parentStreamId: channelB,
      rootStreamId: channelB,
    })
    mentionChannel = await seedStream(wsA, authorA)

    const threadMessage = await seedMessage(wsA, threadA, authorA, 1)
    const crossRootMessage = await seedMessage(wsA, crossRootThread, authorA, 1)

    convA1 = await seedConversation(wsA, channelA)
    convA2 = await seedConversation(wsA, channelA, { status: ConversationStatuses.RESOLVED })
    convAThread = await seedConversation(wsA, threadA, { primaryMessage: { id: threadMessage, author: authorA } })
    convBInChannelA = await seedConversation(wsB, channelA, {
      primaryMessage: { id: await seedMessage(wsB, channelA, authorB, 1), author: authorB },
    })
    convAInThreadB = await seedConversation(wsA, threadB, {
      primaryMessage: { id: await seedMessage(wsA, threadB, authorA, 1), author: authorA },
    })
    convACrossRoot = await seedConversation(wsA, crossRootThread, {
      primaryMessage: { id: crossRootMessage, author: authorA },
    })

    const mentionMessage = await seedMessage(wsA, mentionChannel, authorA, 1)
    convMention = await seedConversation(wsA, mentionChannel, {
      primaryMessage: { id: mentionMessage, author: authorA },
    })

    foreignMessage = await seedMessage(wsB, channelB, authorB, 1)
    foreignSecondary = messageId()
    foreignFilled = await seedConversation(wsB, channelB, { primaryMessage: { id: foreignMessage, author: authorB } })
    await ConversationRepository.addSecondaryMessage(pool, wsB, foreignFilled, foreignSecondary)
    foreignEmpty = await seedConversation(wsB, channelB)
    foreignResolved = await seedConversation(wsB, channelB, { status: ConversationStatuses.RESOLVED })

    boardLabel = labelId()
    await pool.query(
      `INSERT INTO user_activity (id, workspace_id, user_id, activity_type, stream_id, message_id, actor_id, actor_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'user'), ($8, $9, $3, $4, $10, $11, $12, 'user')`,
      [
        activityId(),
        wsA,
        viewerA,
        ActivityTypes.MENTION,
        mentionChannel,
        mentionMessage,
        authorA,
        activityId(),
        wsB,
        threadA,
        threadMessage,
        authorB,
      ]
    )
    await pool.query(
      `INSERT INTO board_hidden_conversations (workspace_id, conversation_id, user_id, hidden_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')`,
      [wsB, convAThread, viewerA]
    )
    await pool.query(`INSERT INTO board_muted_streams (workspace_id, stream_id, user_id) VALUES ($1, $2, $3)`, [
      wsB,
      channelA,
      viewerA,
    ])
    await pool.query(
      `INSERT INTO label_assignments (workspace_id, label_id, resource_type, resource_id, user_id, actor_type)
       VALUES ($1, $2, $3, $4, $5, 'user'), ($6, $2, $3, $7, $5, 'user')`,
      [wsA, boardLabel, LabelableResourceTypes.STREAM, threadA, viewerA, wsB, mentionChannel]
    )
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should return a conversation only for its own workspace when finding by id", async () => {
    expect({
      own: (await ConversationRepository.findById(pool, wsA, convA1))?.id,
      foreignFromA: await ConversationRepository.findById(pool, wsA, convBInChannelA),
      foreignFromB: (await ConversationRepository.findById(pool, wsB, convBInChannelA))?.id,
    }).toEqual({ own: convA1, foreignFromA: null, foreignFromB: convBInChannelA })
  })

  test("should return conversations only for their own workspace when finding by stream", async () => {
    expect({
      all: ids(await ConversationRepository.findByStream(pool, wsA, channelA)),
      active: ids(await ConversationRepository.findByStream(pool, wsA, channelA, { status: "active" })),
      activeShortcut: ids(await ConversationRepository.findActiveByStream(pool, wsA, channelA)),
      foreign: ids(await ConversationRepository.findByStream(pool, wsB, channelA)),
    }).toEqual({
      all: [convA1, convA2].sort(),
      active: [convA1],
      activeShortcut: [convA1],
      foreign: [convBInChannelA],
    })
  })

  test("should return conversations only for their own workspace when finding by stream including threads", async () => {
    expect({
      all: ids(await ConversationRepository.findByStreamIncludingThreads(pool, wsA, channelA)),
      active: ids(await ConversationRepository.findByStreamIncludingThreads(pool, wsA, channelA, { status: "active" })),
    }).toEqual({
      all: [convA1, convA2, convAThread].sort(),
      active: [convA1, convAThread].sort(),
    })
  })

  test("should return conversations only under roots of their own workspace when finding for roots", async () => {
    expect({
      underOwnRoot: ids(await ConversationRepository.findByWorkspaceForRoots(pool, wsA, [channelA])),
      underForeignRoot: ids(await ConversationRepository.findByWorkspaceForRoots(pool, wsA, [channelB])),
    }).toEqual({ underOwnRoot: [convAThread], underForeignRoot: [] })
  })

  test("should return a conversation only for its own workspace when getting through the service", async () => {
    expect({
      own: (await service.getById(wsA, convA1))?.id,
      foreign: await service.getById(wsA, convBInChannelA),
    }).toEqual({ own: convA1, foreign: null })
  })

  test("should list conversations only for their own workspace when listing a stream through the service", async () => {
    expect(ids(await service.listByStream(wsA, channelA))).toEqual([convA1, convA2, convAThread].sort())
  })

  test("should propose a split only for a conversation of its own workspace when proposing", async () => {
    const boundary = new BoundaryExtractionService(pool, new StubBoundaryExtractor())
    const foreign = await boundary.proposeSplit(convBInChannelA, wsA).catch((error) => error)

    expect({
      own: (await boundary.proposeSplit(convA1, wsA)).conversationId,
      foreign: { status: foreign.status, code: foreign.code },
    }).toEqual({ own: convA1, foreign: { status: 404, code: "CONVERSATION_NOT_FOUND" } })
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

  test("should record a user placement only for its own workspace's messages when settling by user", async () => {
    const stream = await seedStream(wsA, authorA)
    const conversation = await seedConversation(wsA, stream)
    const own = await seedMessage(wsA, stream, authorA, 1)
    const foreign = await seedMessage(wsB, stream, authorB, 2)

    const settled = await MessageConversationStateRepository.settleForConversationTargets(
      pool,
      wsA,
      [own, foreign],
      conversation,
      "user"
    )

    expect({ settled: settled.map((row) => row.messageId), stored: await storedStates([own, foreign]) }).toEqual({
      settled: [own],
      stored: {
        [own]: expect.objectContaining({ workspaceId: wsA, conversationId: conversation, state: "settled" }),
      },
    })
  })

  test("should leave another workspace's state row untouched when a user placement conflicts with it", async () => {
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

    expect({ settled, stored: await storedStates([own]) }).toEqual({
      settled: [],
      stored: {
        [own]: expect.objectContaining({ workspaceId: wsB, conversationId: foreignOwner, state: "settling" }),
      },
    })
  })

  test("should settle only its own workspace's rows when settling for a conversation target", async () => {
    const { stream, conversation, own, foreign } = await seedSettlingPair()
    const target = await seedConversation(wsA, stream)

    const settled = await MessageConversationStateRepository.settleForConversationTargets(
      pool,
      wsA,
      [own, foreign],
      target,
      "llm-window"
    )

    expect({ settled: settled.map((row) => row.messageId), stored: await storedStates([own, foreign]) }).toEqual({
      settled: [own],
      stored: {
        [own]: expect.objectContaining({ workspaceId: wsA, conversationId: target, state: "settled" }),
        [foreign]: expect.objectContaining({ workspaceId: wsB, conversationId: conversation, state: "settling" }),
      },
    })
  })

  test("should move only its own workspace's rows when moving a conversation", async () => {
    const { stream, conversation, own, foreign } = await seedSettlingPair()
    const target = await seedConversation(wsA, stream)

    await MessageConversationStateRepository.moveConversation(pool, wsA, [own, foreign], target)

    expect(await storedStates([own, foreign])).toEqual({
      [own]: expect.objectContaining({ workspaceId: wsA, conversationId: target, state: "settling" }),
      [foreign]: expect.objectContaining({ workspaceId: wsB, conversationId: conversation, state: "settling" }),
    })
  })

  test("should list only its own workspace's settling messages when listing by conversation", async () => {
    const { conversation, own } = await seedSettlingPair()

    expect(
      Object.fromEntries(
        await MessageConversationStateRepository.listSettlingByConversationIds(pool, wsA, [conversation])
      )
    ).toEqual({ [conversation]: [own] })
  })

  test("should plan a conversation whose stream is sealed only in another workspace when planning the backfill", async () => {
    const sealedHere = await seedStream(wsA, authorA)
    const sealedElsewhere = await seedStream(wsA, authorA)
    const eligible = async (stream: string) =>
      seedConversation(wsA, stream, {
        primaryMessage: { id: await seedMessage(wsA, stream, authorA, 1), author: authorA },
      })
    const hereId = await eligible(sealedHere)
    const elsewhereId = await eligible(sealedElsewhere)
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: sealedHere,
      workspaceId: wsA,
      ownerUserId: authorA,
      ownerUserKeyId: userEncryptionKeyId(),
    })
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: sealedElsewhere,
      workspaceId: wsB,
      ownerUserId: authorB,
      ownerUserKeyId: userEncryptionKeyId(),
    })

    const planned = (await plan({ pool }, wsA)).flatMap((chunk) => chunk.ids)

    expect(planned.filter((id) => [hereId, elsewhereId, foreignFilled].includes(id))).toEqual([elsewhereId])
  })

  test("should list only its own workspace's conversations when listing the board feed for a viewer", async () => {
    expect({
      default: await boardFeedIds(),
      mine: await boardFeedIds({ lens: "mine" }),
      labelScope: await boardFeedIds({ scopeLabelIds: [boardLabel] }),
      labelExclude: await boardFeedIds({ excludeLabelIds: [boardLabel] }),
    }).toEqual({
      default: [convAThread, convMention].sort(),
      mine: [convMention],
      labelScope: [convAThread],
      labelExclude: [convMention],
    })
  })

  test("should find no conversation of another workspace when reading with its ids", async () => {
    const primaries = await ConversationRepository.findPrimariesByMessageIds(pool, wsA, [foreignMessage])
    const hashes = await ConversationRepository.findEmbeddingSourceHashes(pool, wsA, [foreignFilled])
    const listed = [
      ...(await ConversationRepository.findByWorkspace(pool, wsA, { limit: 1000 })),
      ...(await ConversationRepository.findByWorkspace(pool, wsA, { status: "active", limit: 1000 })),
    ]

    expect({
      forUpdate: await ConversationRepository.findByIdForUpdate(pool, wsA, foreignFilled),
      byIds: await ConversationRepository.findByIds(pool, wsA, [foreignFilled, foreignEmpty]),
      latestActive: await ConversationRepository.findLatestActiveByStream(pool, wsA, channelB, new Date(0)),
      byMessage: await ConversationRepository.findByMessageId(pool, wsA, foreignMessage),
      bySecondaryMessage: await ConversationRepository.findByMessageIds(pool, wsA, [foreignSecondary]),
      primary: await ConversationRepository.findPrimaryByMessageId(pool, wsA, foreignMessage),
      primaries: [...primaries.keys()],
      hashes: [...hashes.keys()],
      listedForeign: ids(listed.filter((conversation) => conversation.workspaceId !== wsA)),
    }).toEqual({
      forUpdate: null,
      byIds: [],
      latestActive: null,
      byMessage: [],
      bySecondaryMessage: [],
      primary: null,
      primaries: [],
      hashes: [],
      listedForeign: [],
    })
  })

  test("should leave another workspace's conversations unchanged when writing with their ids", async () => {
    const foreignIds = [foreignFilled, foreignEmpty, foreignResolved]
    const before = await storedConversations(foreignIds)

    const results = {
      update: await ConversationRepository.update(pool, wsA, foreignFilled, { summary: "intruder" }),
      noopUpdate: await ConversationRepository.update(pool, wsA, foreignFilled, {}),
      topicSummary: await ConversationRepository.updateTopicSummary(pool, {
        workspaceId: wsA,
        conversationId: foreignFilled,
        topicSummary: "intruder",
        source: TitleSources.EXPLICIT,
      }),
      embeddings: await ConversationRepository.updateEmbeddings(pool, wsA, [
        { id: foreignFilled, embedding: UNIT_EMBEDDING, sourceHash: "intruder", expectedSourceHash: null },
      ]),
      reactivated: await ConversationRepository.reactivateIfInactive(pool, wsA, foreignResolved),
    }
    await ConversationRepository.applyExtractionUpdate(pool, wsA, foreignFilled, {
      completenessScore: 5,
      summary: "intruder",
    })
    await ConversationRepository.addPrimaryMessage(pool, wsA, foreignFilled, messageId(), authorA)
    await ConversationRepository.addSecondaryMessage(pool, wsA, foreignFilled, messageId())
    await ConversationRepository.removePrimaryMessage(pool, wsA, foreignFilled, foreignMessage)
    await ConversationRepository.removePrimaryMessages(pool, wsA, foreignFilled, [foreignMessage], [])
    await ConversationRepository.addPrimaryMessages(pool, wsA, foreignFilled, [messageId()], [authorA])
    await ConversationRepository.resolveIfEmpty(pool, wsA, foreignEmpty)
    await ConversationRepository.bumpActivityForIds(pool, wsA, [foreignFilled, foreignEmpty])

    expect({ results, stored: await storedConversations(foreignIds) }).toEqual({
      results: { update: null, noopUpdate: null, topicSummary: null, embeddings: 0, reactivated: false },
      stored: before,
    })
  })

  test("should find and settle no state row of another workspace when using its message ids", async () => {
    const stream = await seedStream(wsB, authorB)
    const message = await seedMessage(wsB, stream, authorB, 1)
    await seedSettling(wsB, stream, conversationId(), message)
    const before = await storedStates([message])

    expect({
      byMessage: await MessageConversationStateRepository.findByMessageId(pool, wsA, message),
      byMessages: [...(await MessageConversationStateRepository.findByMessageIds(pool, wsA, [message])).keys()],
      settled: await MessageConversationStateRepository.settle(pool, wsA, [message], "user"),
      stored: await storedStates([message]),
    }).toEqual({ byMessage: null, byMessages: [], settled: [], stored: before })
  })
})
