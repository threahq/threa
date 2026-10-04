import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthoredByKinds, MemoryModes, StreamTypes, Visibilities } from "@threahq/types"
import { MemoRepository, MemoService, type MemoAudience } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { memoId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
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

  async function seedChannel(id: string): Promise<void> {
    await StreamRepository.insert(pool, {
      id,
      workspaceId: testWorkspaceId,
      type: StreamTypes.CHANNEL,
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

  test("should store requiresBrowse by the saved audience's browse when an agent saves a memo, and true when no audience resolved", async () => {
    const audiences: Array<MemoAudience | null> = [
      { kind: "streams", streamIds: [home], browses: false },
      { kind: "streams", streamIds: [home], browses: true },
      null,
    ]
    const requiresBrowse: Array<boolean | undefined> = []
    for (const audience of audiences) {
      const saved = await saveAgentMemo({ provenanceStreamIds: [home], audience })
      const memo = await MemoRepository.findById(pool, testWorkspaceId, (saved as { memoId: string }).memoId)
      requiresBrowse.push(memo?.requiresBrowse)
    }

    expect(requiresBrowse).toEqual([false, true, true])
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
})
