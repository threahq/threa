import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AuthoredByKinds,
  ConversationStatuses,
  MemoryModes,
  MemoScopes,
  StreamTypes,
  Visibilities,
  type StreamType,
} from "@threahq/types"
import { ConversationRepository } from "../../src/features/conversations"
import { MemoRepository, MemoService, PendingItemRepository, type MemoAudience } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { conversationId, memoId, messageId, pendingItemId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

const worthy: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.9,
  containsActionItems: false,
}

describe("agent memo provenance", () => {
  let pool: Pool
  let service: MemoService
  let testWorkspaceId: string
  let testUserId: string
  let home: string
  let research: string
  let otherResearch: string
  let anchorId: string
  let researchMessageId: string
  let embeddingsIssued = 0
  let pinnedEmbedding: number[] | null = null

  async function seedChannel(id: string, type: StreamType = StreamTypes.CHANNEL): Promise<void> {
    await StreamRepository.insert(pool, {
      id,
      workspaceId: testWorkspaceId,
      type,
      visibility: Visibilities.PRIVATE,
      slug: `c-${id.slice(-8)}`,
      createdBy: testUserId,
      memoryMode: MemoryModes.AUTO,
    })
    await StreamMemberRepository.insert(pool, testWorkspaceId, id, testUserId)
  }

  async function seedThread(parent: string, parentMessageId: string): Promise<string> {
    const id = streamId()
    await StreamRepository.insert(pool, {
      id,
      workspaceId: testWorkspaceId,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      slug: `t-${id.slice(-8)}`,
      createdBy: testUserId,
      parentStreamId: parent,
      parentAnchorId: parentMessageId,
      rootStreamId: parent,
      memoryMode: MemoryModes.AUTO,
    })
    return id
  }

  async function seedMessage(stream: string, text: string): Promise<string> {
    const id = messageId()
    await MessageRepository.insert(pool, {
      workspaceId: testWorkspaceId,
      id,
      streamId: stream,
      sequence: 1n,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent(text),
    })
    return id
  }

  const saveAgentMemo = (params: {
    provenanceStreamIds: string[]
    audience: MemoAudience | null
    requiresBrowse?: boolean
    streamId?: string
    anchor?: string
  }) =>
    service.saveMemo({
      workspaceId: testWorkspaceId,
      streamId: params.streamId ?? home,
      sessionId: null,
      sourceStreamIds: [params.streamId ?? home],
      title: "Rollout plan",
      abstract: "The rollout starts on Monday with the flag off.",
      keyPoints: [],
      tags: [],
      knowledgeType: "decision",
      sourceMessageIds: [params.anchor ?? anchorId],
      provenanceStreamIds: params.provenanceStreamIds,
      audience: params.audience,
      requiresBrowse: params.requiresBrowse ?? true,
    })

  const unitVector = (index: number) => Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0))

  async function seedAgentMemo(stream: string, anchor: string, sourceStreamIds: string[]): Promise<string> {
    const id = memoId()
    await MemoRepository.insert(pool, {
      id,
      workspaceId: testWorkspaceId,
      memoType: "message",
      sourceMessageId: anchor,
      title: "Rollout plan",
      abstract: "The rollout starts on Monday with the flag off.",
      keyPoints: [],
      sourceMessageIds: [anchor],
      participantIds: [testUserId],
      knowledgeType: "decision",
      tags: [],
      status: "active",
      authoredByKind: AuthoredByKinds.AGENT,
      sourceStreamIds,
      requiresBrowse: false,
    })
    await MemoRepository.updateEmbedding(pool, testWorkspaceId, id, pinnedEmbedding!)
    return id
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new MemoService({
      analyticsReporter: new DisabledAnalyticsReporter(),
      pool,
      classifier: { classifyConversation: async () => worthy } as never,
      memorizer: {
        memorizeConversation: async () => [
          {
            title: "Rollout plan",
            abstract: "The rollout starts on Monday with the flag off.",
            keyPoints: [],
            sourceMessageIds: [],
            knowledgeType: "decision",
            tags: [],
          },
        ],
      } as never,
      embeddingService: {
        embedBatch: async (texts: string[]) => texts.map(() => pinnedEmbedding ?? unitVector(embeddingsIssued++)),
      } as never,
      messageFormatter: {} as never,
    })

    testWorkspaceId = workspaceId()
    const workosUserId = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Memo Provenance",
        slug: `memo-provenance-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
    })
    home = streamId()
    research = streamId()
    otherResearch = streamId()
    for (const id of [home, research, otherResearch]) await seedChannel(id)
    anchorId = await seedMessage(home, "the rollout starts on Monday")
    researchMessageId = await seedMessage(research, "the flag defaults to off")
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should store the turn's streams together with every stream whose content reached the model when an agent saves a memo", async () => {
    const saved = await saveAgentMemo({
      provenanceStreamIds: [research, otherResearch, home, research],
      audience: { kind: "streams", streamIds: [home], browses: true },
    })
    expect(saved).toMatchObject({ ok: true, deduped: false })

    const memo = await MemoRepository.findById(pool, testWorkspaceId, (saved as { memoId: string }).memoId)

    expect(memo).toMatchObject({
      authoredByKind: AuthoredByKinds.AGENT,
      sourceStreamIds: [home, research, otherResearch].sort(),
      requiresBrowse: true,
    })
  })

  test("should store the cited streams together with the session's stream and its root when a reflective capture runs in a thread", async () => {
    const thread = await seedThread(home, anchorId)
    const threadAnchorId = await seedMessage(thread, "which flag flips on Monday?")
    const session = `session_${thread}`

    const result = await service.captureSessionReflection({
      workspaceId: testWorkspaceId,
      streamId: thread,
      sessionId: session,
      digest: "Trigger: which flag flips on Monday?",
      anchorMessageId: threadAnchorId,
      participantIds: [testUserId],
      citedStreamIds: [research, otherResearch],
      citedMessageIds: [researchMessageId],
      requiresBrowse: true,
    })
    expect(result).toMatchObject({ classified: true, captured: 1 })

    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM memos WHERE source_session_id = $1`, [session])
    const memo = await MemoRepository.findById(pool, testWorkspaceId, rows[0].id)

    expect(memo).toMatchObject({
      authoredByKind: AuthoredByKinds.AGENT,
      sourceSessionId: session,
      sourceStreamIds: [home, thread, research, otherResearch].sort(),
      requiresBrowse: true,
    })
  })

  test("should store the requiresBrowse the turn observed when an agent saves a memo", async () => {
    const stored: Array<boolean | undefined> = []
    for (const requiresBrowse of [false, true]) {
      const saved = await saveAgentMemo({
        provenanceStreamIds: [home],
        audience: { kind: "streams", streamIds: [home], browses: !requiresBrowse },
        requiresBrowse,
      })
      const memo = await MemoRepository.findById(pool, testWorkspaceId, (saved as { memoId: string }).memoId)
      stored.push(memo?.requiresBrowse)
    }

    expect(stored).toEqual([false, true])
  })

  test("should store requiresBrowse false for a reflective capture when the session ran for an audience that needs no browse", async () => {
    const session = `session_${streamId()}`
    await service.captureSessionReflection({
      workspaceId: testWorkspaceId,
      streamId: home,
      sessionId: session,
      digest: "Trigger: when does the rollout start?",
      anchorMessageId: anchorId,
      participantIds: [testUserId],
      citedStreamIds: [],
      citedMessageIds: [],
      requiresBrowse: false,
    })

    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM memos WHERE source_session_id = $1`, [session])
    const reflected = await MemoRepository.findById(pool, testWorkspaceId, rows[0].id)

    expect(reflected?.requiresBrowse).toBe(false)
  })

  describe("dedupe against what the saver's audience can read", () => {
    const readersOf = (stream: string): MemoAudience => ({ kind: "streams", streamIds: [stream], browses: true })

    beforeAll(() => {
      pinnedEmbedding = unitVector(1535)
    })

    afterAll(() => {
      pinnedEmbedding = null
    })

    test("should insert a new memo when the only near-identical memo is hidden from the saver's audience", async () => {
      const stream = streamId()
      await seedChannel(stream)
      const anchor = await seedMessage(stream, "the rollout starts on Monday")
      const hidden = await seedAgentMemo(stream, anchor, [stream, research])

      const saved = await saveAgentMemo({
        streamId: stream,
        anchor,
        provenanceStreamIds: [],
        audience: readersOf(stream),
      })

      expect(saved).toEqual({
        ok: true,
        memoId: expect.not.stringContaining(hidden),
        title: "Rollout plan",
        deduped: false,
        scope: "workspace",
      })
    })

    test("should dedupe to the existing memo when it is visible to the saver's audience", async () => {
      const stream = streamId()
      await seedChannel(stream)
      const anchor = await seedMessage(stream, "the rollout starts on Monday")
      const visible = await seedAgentMemo(stream, anchor, [stream])

      const saved = await saveAgentMemo({
        streamId: stream,
        anchor,
        provenanceStreamIds: [],
        audience: readersOf(stream),
      })

      expect(saved).toEqual({ ok: true, memoId: visible, title: "Rollout plan", deduped: true, scope: "workspace" })
    })

    test("should insert a new memo when no audience resolved and the near-identical memo cites a stream the room can't read", async () => {
      const stream = streamId()
      await seedChannel(stream)
      const anchor = await seedMessage(stream, "the rollout starts on Monday")
      const hidden = await seedAgentMemo(stream, anchor, [stream, research])

      const saved = await saveAgentMemo({ streamId: stream, anchor, provenanceStreamIds: [], audience: null })

      expect(saved).toEqual({
        ok: true,
        memoId: expect.not.stringContaining(hidden),
        title: "Rollout plan",
        deduped: false,
        scope: "workspace",
      })
    })
  })

  describe("processBatch shows, dedupes against and retires only memos the room reads", () => {
    const captureEmbedding = unitVector(1400)
    const nearCaptureEmbedding = Array.from({ length: 1536 }, (_, i) => {
      if (i === 1400) return 0.75
      return i === 1405 ? Math.sqrt(1 - 0.75 ** 2) : 0
    })
    let pipeline: MemoService
    let shownToMemorizer: string[][] = []
    let supersedes: string[] = []

    beforeEach(() => {
      shownToMemorizer = []
      supersedes = []
    })

    beforeAll(() => {
      const memorize = async (
        _formatted: string,
        context: { memoryContext: { id: string }[]; content: { id: string }[] }
      ) => {
        shownToMemorizer.push(context.memoryContext.map((memo) => memo.id).sort())
        return [
          {
            title: "Rollout plan",
            abstract: "The rollout starts on Monday with the flag off.",
            keyPoints: [],
            sourceMessageIds: context.content.map((message) => message.id),
            knowledgeType: "decision",
            tags: [],
            supersedesMemoIds: supersedes,
          },
        ]
      }
      pipeline = new MemoService({
        analyticsReporter: new DisabledAnalyticsReporter(),
        pool,
        classifier: {
          classifyConversation: async () => ({ ...worthy, shouldReviseExisting: true, revisionReason: "moved on" }),
        } as never,
        memorizer: { memorizeConversation: memorize, reviseMemo: memorize } as never,
        embeddingService: { embedBatch: async (texts: string[]) => texts.map(() => captureEmbedding) } as never,
        messageFormatter: { formatMessages: async () => "formatted transcript" } as never,
      })
    })

    async function seedRoom(type: StreamType = StreamTypes.CHANNEL) {
      const room = streamId()
      await seedChannel(room, type)
      const pub = streamId()
      await StreamRepository.insert(pool, {
        id: pub,
        workspaceId: testWorkspaceId,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        slug: `p-${pub.slice(-8)}`,
        createdBy: testUserId,
        memoryMode: MemoryModes.AUTO,
      })
      let sequence = 0n
      const post = async (text: string) => {
        const id = messageId()
        await MessageRepository.insert(pool, {
          workspaceId: testWorkspaceId,
          id,
          streamId: room,
          sequence: ++sequence,
          authorId: testUserId,
          authorType: "user",
          ...testMessageContent(text),
        })
        return id
      }
      const anchor = await post("the rollout starts on Monday")
      const conversation = async () => {
        const id = conversationId()
        await ConversationRepository.insert(pool, {
          id,
          streamId: room,
          workspaceId: testWorkspaceId,
          status: ConversationStatuses.RESOLVED,
        })
        return id
      }
      const queueCapture = async () => {
        const conv = await conversation()
        for (const text of ["when does the rollout start?", "Monday, flag off"]) {
          await ConversationRepository.addPrimaryMessage(pool, testWorkspaceId, conv, await post(text), testUserId)
        }
        await withTransaction(pool, (client) =>
          PendingItemRepository.queue(client, [
            {
              id: pendingItemId(),
              workspaceId: testWorkspaceId,
              streamId: room,
              itemType: "conversation",
              itemId: conv,
            },
          ])
        )
        return conv
      }
      return { room, pub, anchor, conversation, queueCapture }
    }

    async function seedMemo(
      fields: {
        sourceMessageId?: string
        sourceConversationId?: string
        cites?: string
        sourceStreamIds?: string[]
        scopeUserId?: string
      },
      requiresBrowse: boolean,
      embedding: number[]
    ): Promise<string> {
      const id = memoId()
      await MemoRepository.insert(pool, {
        id,
        workspaceId: testWorkspaceId,
        memoType: fields.sourceMessageId ? "message" : "conversation",
        sourceMessageId: fields.sourceMessageId,
        sourceConversationId: fields.sourceConversationId,
        title: "Rollout plan",
        abstract: "The rollout starts on Monday with the flag off.",
        keyPoints: [],
        sourceMessageIds: [fields.sourceMessageId ?? fields.cites].filter((id): id is string => id !== undefined),
        participantIds: [testUserId],
        knowledgeType: "decision",
        tags: [],
        status: "active",
        ...(fields.scopeUserId ? { scope: MemoScopes.USER, scopeUserId: fields.scopeUserId } : {}),
        ...(fields.sourceStreamIds
          ? { authoredByKind: AuthoredByKinds.AGENT, sourceStreamIds: fields.sourceStreamIds, requiresBrowse }
          : {}),
      })
      await MemoRepository.updateEmbedding(pool, testWorkspaceId, id, embedding)
      return id
    }

    async function capture(room: string, scopeUserId: string | null = null) {
      const result = await pipeline.processBatch(testWorkspaceId, room)
      const active = await MemoRepository.findByStream(pool, testWorkspaceId, room, {
        scopeUserId,
        audiences: [],
        status: "active",
      })
      return { result, active }
    }

    test("should show the memorizer only the memos the room reads", async () => {
      const { room, anchor, queueCapture } = await seedRoom()
      const visible = await seedMemo({ sourceMessageId: anchor, sourceStreamIds: [room] }, false, unitVector(1401))
      await seedMemo({ sourceMessageId: anchor, sourceStreamIds: [room, research] }, false, unitVector(1402))
      await queueCapture()

      await pipeline.processBatch(testWorkspaceId, room)

      expect(shownToMemorizer).toEqual([[visible]])
    })

    test("should insert a new memo when the only near-identical memo cites a stream the room can't read", async () => {
      const { room, anchor, queueCapture } = await seedRoom()
      const hidden = await seedMemo(
        { sourceMessageId: anchor, sourceStreamIds: [room, research] },
        false,
        captureEmbedding
      )
      await queueCapture()

      const { result, active } = await capture(room)

      expect({ result, active: active.map((memo) => (memo.id === hidden ? "hidden" : "new")).sort() }).toEqual({
        result: { processed: 1, memosCreated: 1 },
        active: ["hidden", "new"],
      })
    })

    test("should dedupe to the near-identical memo when the room reads it", async () => {
      const { room, anchor, queueCapture } = await seedRoom()
      const visible = await seedMemo({ sourceMessageId: anchor, sourceStreamIds: [room] }, false, captureEmbedding)
      await queueCapture()

      const { result, active } = await capture(room)

      expect({ result, activeIds: active.map((memo) => memo.id) }).toEqual({
        result: { processed: 1, memosCreated: 0 },
        activeIds: [visible],
      })
    })

    test("should give a revision the sources and browse need of the agent memo it supersedes", async () => {
      const { room, pub, anchor, queueCapture } = await seedRoom()
      const retired = await seedMemo({ sourceMessageId: anchor, sourceStreamIds: [room, pub] }, true, unitVector(1403))
      supersedes = [retired]
      await queueCapture()

      const { result, active } = await capture(room)

      expect({
        result,
        stored: active.map(({ parentMemoId, sourceStreamIds, requiresBrowse, authoredByKind }) => ({
          parentMemoId,
          sourceStreamIds,
          requiresBrowse,
          authoredByKind,
        })),
      }).toEqual({
        result: { processed: 1, memosCreated: 1 },
        stored: [
          {
            parentMemoId: retired,
            sourceStreamIds: [room, pub].sort(),
            requiresBrowse: true,
            authoredByKind: AuthoredByKinds.PIPELINE,
          },
        ],
      })
    })

    test("should leave a revision without sources when it supersedes a pipeline memo", async () => {
      const { room, anchor, conversation, queueCapture } = await seedRoom()
      const retired = await seedMemo(
        { sourceConversationId: await conversation(), cites: anchor },
        false,
        unitVector(1404)
      )
      supersedes = [retired]
      await queueCapture()

      const { result, active } = await capture(room)

      expect({
        result,
        stored: active.map(({ parentMemoId, sourceStreamIds, requiresBrowse }) => ({
          parentMemoId,
          sourceStreamIds,
          requiresBrowse,
        })),
      }).toEqual({
        result: { processed: 1, memosCreated: 1 },
        stored: [{ parentMemoId: retired, sourceStreamIds: null, requiresBrowse: false }],
      })
    })

    test("should give a revision the sources and browse need of the memo it supersedes by closeness when the memorizer cites none", async () => {
      const { room, pub, anchor, queueCapture } = await seedRoom()
      const conv = await queueCapture()
      const retired = await seedMemo(
        { sourceConversationId: conv, cites: anchor, sourceStreamIds: [room, pub] },
        true,
        nearCaptureEmbedding
      )

      const { result, active } = await capture(room)

      expect({
        result,
        stored: active.map(({ parentMemoId, sourceStreamIds, requiresBrowse, authoredByKind }) => ({
          parentMemoId,
          sourceStreamIds,
          requiresBrowse,
          authoredByKind,
        })),
      }).toEqual({
        result: { processed: 1, memosCreated: 1 },
        stored: [
          {
            parentMemoId: retired,
            sourceStreamIds: [room, pub].sort(),
            requiresBrowse: true,
            authoredByKind: AuthoredByKinds.PIPELINE,
          },
        ],
      })
    })

    describe("in a private scratchpad", () => {
      async function seedOwnerDm(): Promise<string> {
        const dm = streamId()
        const peer = await withTransaction(pool, (client) => addTestMember(client, testWorkspaceId, userId()))
        await StreamRepository.insert(pool, {
          id: dm,
          workspaceId: testWorkspaceId,
          type: StreamTypes.DM,
          visibility: Visibilities.PRIVATE,
          createdBy: testUserId,
          memoryMode: MemoryModes.AUTO,
        })
        for (const member of [testUserId, peer.id]) {
          await StreamMemberRepository.insert(pool, testWorkspaceId, dm, member)
        }
        return dm
      }

      async function seedUnreadableChannel(): Promise<string> {
        const id = streamId()
        await StreamRepository.insert(pool, {
          id,
          workspaceId: testWorkspaceId,
          type: StreamTypes.CHANNEL,
          visibility: Visibilities.PRIVATE,
          slug: `c-${id.slice(-8)}`,
          createdBy: testUserId,
          memoryMode: MemoryModes.AUTO,
        })
        return id
      }

      test("should show the memorizer the owner's agent memo citing their private DM and not one citing a stream they can't read", async () => {
        const { room: pad, anchor, queueCapture } = await seedRoom(StreamTypes.SCRATCHPAD)
        const dm = await seedOwnerDm()
        const visible = await seedMemo(
          { sourceMessageId: anchor, sourceStreamIds: [pad, dm], scopeUserId: testUserId },
          false,
          unitVector(1401)
        )
        await seedMemo(
          { sourceMessageId: anchor, sourceStreamIds: [pad, await seedUnreadableChannel()], scopeUserId: testUserId },
          false,
          unitVector(1402)
        )
        await queueCapture()

        await pipeline.processBatch(testWorkspaceId, pad)

        expect(shownToMemorizer).toEqual([[visible]])
      })

      test("should dedupe to the owner's near-identical agent memo that cites their private DM", async () => {
        const { room: pad, anchor, queueCapture } = await seedRoom(StreamTypes.SCRATCHPAD)
        const dm = await seedOwnerDm()
        const visible = await seedMemo(
          { sourceMessageId: anchor, sourceStreamIds: [pad, dm], scopeUserId: testUserId },
          false,
          captureEmbedding
        )
        await queueCapture()

        const { result, active } = await capture(pad, testUserId)

        expect({ result, activeIds: active.map((memo) => memo.id) }).toEqual({
          result: { processed: 1, memosCreated: 0 },
          activeIds: [visible],
        })
      })

      test("should insert a new memo when the only near-identical memo cites a stream the owner can't read", async () => {
        const { room: pad, anchor, queueCapture } = await seedRoom(StreamTypes.SCRATCHPAD)
        const hidden = await seedMemo(
          { sourceMessageId: anchor, sourceStreamIds: [pad, await seedUnreadableChannel()], scopeUserId: testUserId },
          false,
          captureEmbedding
        )
        await queueCapture()

        const { result, active } = await capture(pad, testUserId)

        expect({ result, active: active.map((memo) => (memo.id === hidden ? "hidden" : "new")).sort() }).toEqual({
          result: { processed: 1, memosCreated: 1 },
          active: ["hidden", "new"],
        })
      })
    })

    describe("repository reads gate on the audience", () => {
      test("should leave out of the conversation's memos one citing a stream the room can't read, unless no audience is given", async () => {
        const { room, anchor, conversation } = await seedRoom()
        const conv = await conversation()
        const visible = await seedMemo(
          { sourceConversationId: conv, cites: anchor, sourceStreamIds: [room] },
          false,
          unitVector(1410)
        )
        const hidden = await seedMemo(
          { sourceConversationId: conv, cites: anchor, sourceStreamIds: [room, research] },
          false,
          unitVector(1411)
        )
        const idsFor = async (audiences: MemoAudience[]) =>
          (await MemoRepository.findActiveBySourceConversation(pool, testWorkspaceId, conv, audiences))
            .map((memo) => memo.id)
            .sort()

        const [gated, ungated] = await Promise.all([idsFor([{ kind: "room", roomStreamId: room }]), idsFor([])])

        expect({ gated, ungated }).toEqual({ gated: [visible], ungated: [visible, hidden].sort() })
      })

      test("should leave out of the edited-citation memos one citing a stream the room can't read, unless no audience is given", async () => {
        const { room, anchor } = await seedRoom()
        const visible = await seedMemo({ sourceMessageId: anchor, sourceStreamIds: [room] }, false, unitVector(1412))
        const hidden = await seedMemo(
          { sourceMessageId: anchor, sourceStreamIds: [room, research] },
          false,
          unitVector(1413)
        )
        await pool.query(`UPDATE messages SET edited_at = NOW() + INTERVAL '1 minute' WHERE id = $1`, [anchor])
        const idsFor = async (audiences: MemoAudience[]) =>
          (await MemoRepository.findActiveMessageMemosCitingEdited(pool, testWorkspaceId, [anchor], null, audiences))
            .map((memo) => memo.id)
            .sort()

        const [gated, ungated] = await Promise.all([idsFor([{ kind: "room", roomStreamId: room }]), idsFor([])])

        expect({ gated, ungated }).toEqual({ gated: [visible], ungated: [visible, hidden].sort() })
      })
    })
  })
})
