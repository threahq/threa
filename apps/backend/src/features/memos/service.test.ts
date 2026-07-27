import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import type { Conversation } from "../conversations"
import type { Message } from "../messaging"
import { MemoService } from "./service"
import { MEMO_REFLECTIVE_MAX_MEMOS } from "./config"
import { MemoRepository } from "./repository"
import { PendingItemRepository, type PendingMemoItem } from "./pending-item-repository"
import { classificationFingerprint } from "./classification-fingerprint"
import type { MemoContent } from "./memorizer"
import type { ConversationClassification } from "./classifier"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository, StreamStateRepository, StreamRepository, type Stream } from "../streams"
import type { StreamEvent } from "../streams"
import { ConversationRepository } from "../conversations"
import { MessageRepository } from "../messaging"
import { LinkPreviewRepository } from "../link-previews"
import { StreamContextRepository } from "../stream-context"
import { UserRepository } from "../workspaces"
import { WorkspaceSettingsRepository } from "../workspace-settings"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"
const CONVERSATION_ID = "conv_1"

function fakePendingItem(overrides: Partial<PendingMemoItem> = {}): PendingMemoItem {
  return {
    id: "pend_1",
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    itemType: "conversation",
    itemId: CONVERSATION_ID,
    queuedAt: new Date(),
    processedAt: null,
    classifiedFingerprint: null,
    ...overrides,
  }
}

function fakeConversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    streamId: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    topicSummary: "Deciding on ID format",
    completenessScore: 1,
    confidence: 1,
    status: "complete",
    parentConversationId: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    messageIds: ["msg_1", "msg_2"],
    participantIds: ["usr_1"],
    secondaryMessageIds: [],
  } as unknown as Conversation
}

function fakeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    type: "channel",
    slug: "general",
    displayName: "general",
    visibility: "public",
    createdBy: "usr_owner",
    rootStreamId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    ...overrides,
  } as unknown as Stream
}

function fakeMessages(): Map<string, Message> {
  const base = {
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    authorId: "usr_1",
    authorType: "user",
  }
  return new Map<string, Message>([
    [
      "msg_1",
      { ...base, id: "msg_1", sequence: 1n, createdAt: new Date("2026-07-01T10:00:00.000Z") } as unknown as Message,
    ],
    [
      "msg_2",
      { ...base, id: "msg_2", sequence: 2n, createdAt: new Date("2026-07-01T10:05:00.000Z") } as unknown as Message,
    ],
  ])
}

const memoContent: MemoContent = {
  title: "Use prefixed ULIDs for all entities",
  abstract: "The team decided every entity id is a prefixed ULID.",
  knowledgeType: "decision",
  keyPoints: ["Prefixed ULIDs everywhere"],
  tags: ["ids"],
  sourceMessageIds: ["msg_1", "msg_2"],
  supersedesMemoIds: [],
}

const classification: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.95,
  containsActionItems: false,
}

function setupService(options: { memoContents: MemoContent[]; pendingItem?: Partial<PendingMemoItem> }) {
  const clientQuery = mock(async () => ({ rows: [] }))
  const fakeClient = { query: clientQuery } as unknown as PoolClient
  spyOn(dbModule, "withClient").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withClient)
  spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withTransaction)

  spyOn(PendingItemRepository, "findUnprocessed").mockResolvedValue([fakePendingItem(options.pendingItem)])
  spyOn(PendingItemRepository, "markProcessed").mockResolvedValue(undefined as never)
  const recordFingerprints = spyOn(PendingItemRepository, "recordClassifiedFingerprints").mockResolvedValue(
    undefined as never
  )
  spyOn(MemoRepository, "findByStream").mockResolvedValue([])
  spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
  spyOn(MemoRepository, "getAllTags").mockResolvedValue([])
  spyOn(MemoRepository, "findActiveBySourceConversation").mockResolvedValue([])
  spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue(null)
  spyOn(MemoRepository, "findSameConversationNear").mockResolvedValue([])
  spyOn(MemoRepository, "markSuperseded").mockResolvedValue(undefined as never)
  spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([])
  spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)
  spyOn(MemoRepository, "updateEmbedding").mockResolvedValue(undefined as never)
  spyOn(ConversationRepository, "findById").mockResolvedValue(fakeConversation())
  spyOn(MessageRepository, "findByIds").mockResolvedValue(fakeMessages())
  const findSourceMessages = spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(fakeMessages())
  spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(new Map())
  spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_1", timezone: "UTC" }] as never)
  spyOn(StreamStateRepository, "markProcessed").mockResolvedValue(undefined as never)
  const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
  const outboxInsertMany = spyOn(OutboxRepository, "insertMany").mockResolvedValue([] as never)

  const insertedStreamEvent: StreamEvent = {
    id: "evt_capture",
    streamId: STREAM_ID,
    sequence: 10n,
    broadcastSequence: 7n,
    eventType: "memos:captured",
    payload: {},
    actorId: null,
    actorType: "system",
    createdAt: new Date(),
  }
  const streamEventInsertMany = spyOn(StreamEventRepository, "insertMany").mockResolvedValue([insertedStreamEvent])
  const contextInsertMany = spyOn(StreamContextRepository, "insertMany").mockResolvedValue(0)

  const classifyConversation = mock(async () => classification)

  const service = new MemoService({
    pool: {} as never,
    classifier: { classifyConversation } as never,
    memorizer: {
      memorizeConversation: async () => options.memoContents,
      reviseMemo: async () => [],
    } as never,
    embeddingService: {
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
    } as never,
    messageFormatter: { formatMessages: async () => "formatted conversation" } as never,
  })

  return {
    service,
    streamEventInsertMany,
    outboxInsert,
    outboxInsertMany,
    insertedStreamEvent,
    clientQuery,
    contextInsertMany,
    findSourceMessages,
    classifyConversation,
    recordFingerprints,
  }
}

describe("MemoService.processBatch — memos:captured timeline event (INV-62)", () => {
  afterEach(() => mock.restore())

  it("appends a memos:captured stream event with memo provenance in the save transaction", async () => {
    const { service, streamEventInsertMany, outboxInsertMany, insertedStreamEvent, clientQuery } = setupService({
      memoContents: [memoContent],
    })

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(1)
    // Insert transaction serializes same-stream batches via a per-stream advisory lock (INV-20).
    expect(clientQuery).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(hashtext($1))", [`memo-batch:${STREAM_ID}`])
    expect(streamEventInsertMany).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        streamId: STREAM_ID,
        eventType: "memos:captured",
        actorType: "system",
        payload: {
          conversationId: CONVERSATION_ID,
          memos: [
            {
              memoId: expect.stringMatching(/^memo_/),
              title: memoContent.title,
              knowledgeType: memoContent.knowledgeType,
              sourceMessageIds: memoContent.sourceMessageIds,
            },
          ],
        },
      }),
    ])

    // The full stream event rides the outbox row so clients append it without a fetch
    expect(outboxInsertMany).toHaveBeenCalledWith(expect.anything(), [
      {
        eventType: "stream:memos_captured",
        payload: { workspaceId: WORKSPACE_ID, streamId: STREAM_ID, event: insertedStreamEvent },
      },
    ])
  })

  it("does not append a capture event when the memorizer yields no memos", async () => {
    const { service, streamEventInsertMany, outboxInsertMany } = setupService({ memoContents: [] })

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(0)
    expect(streamEventInsertMany).not.toHaveBeenCalled()
    expect(outboxInsertMany).not.toHaveBeenCalled()
  })

  it("drops a memo whose knowledge already exists in the stream from another conversation", async () => {
    const { service, streamEventInsertMany, outboxInsertMany } = setupService({ memoContents: [memoContent] })

    // The same knowledge was already captured by a different conversation.
    const existing = { ...memoContent, id: "memo_existing", sourceConversationId: "conv_other" } as never
    spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue({ memo: existing, distance: 0.02 })
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(0)
    expect(insert).not.toHaveBeenCalled()
    expect(streamEventInsertMany).not.toHaveBeenCalled()
    expect(outboxInsertMany).not.toHaveBeenCalled()
  })

  it("drops a re-emitted memo from the SAME conversation (revision prompt is not the dedup guard)", async () => {
    const { service, streamEventInsertMany } = setupService({ memoContents: [memoContent] })

    // Re-processing a conversation re-emits a near-identical memo; the
    // embedding gate must catch it even though the source conversation matches.
    const existing = { ...memoContent, id: "memo_prior_emission", sourceConversationId: CONVERSATION_ID } as never
    const findNearDuplicate = spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue({
      memo: existing,
      distance: 0.05,
    })
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(0)
    expect(insert).not.toHaveBeenCalled()
    expect(streamEventInsertMany).not.toHaveBeenCalled()
    // The gate is stream-wide: no conversation is excluded from the search.
    expect(findNearDuplicate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        streamId: STREAM_ID,
        embedding: expect.any(Array),
        maxDistance: expect.any(Number),
      })
    )
  })

  it("supersedes the conversation's prior memo when a revised capture lands near it", async () => {
    const { service } = setupService({ memoContents: [memoContent] })

    // A paraphrased re-capture: outside the dedup gate (0.15) but inside the
    // supersede band — the prod failure where rewordings stacked forever.
    const prior = { ...memoContent, id: "memo_prior", sourceConversationId: CONVERSATION_ID } as never
    const findNear = spyOn(MemoRepository, "findSameConversationNear").mockResolvedValue([
      { memo: prior, distance: 0.22 },
    ])
    const markSuperseded = spyOn(MemoRepository, "markSuperseded").mockResolvedValue(undefined as never)
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(1)
    expect(findNear).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      embedding: expect.any(Array),
      maxDistance: expect.any(Number),
      excludeIds: [],
    })
    expect(markSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      ["memo_prior"],
      expect.stringContaining("Superseded by revised capture")
    )
    // The new memo links back to the memo it replaced.
    expect(insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ parentMemoId: "memo_prior" }))
  })

  it("supersedes every near match but links parentMemoId to the nearest", async () => {
    const { service } = setupService({ memoContents: [memoContent] })

    // Two prior captures of the same drifting topic; both retire, the new
    // memo's lineage points at the closest one.
    const nearest = { ...memoContent, id: "memo_nearest", sourceConversationId: CONVERSATION_ID } as never
    const farther = { ...memoContent, id: "memo_farther", sourceConversationId: CONVERSATION_ID } as never
    spyOn(MemoRepository, "findSameConversationNear").mockResolvedValue([
      { memo: nearest, distance: 0.18 },
      { memo: farther, distance: 0.31 },
    ])
    const markSuperseded = spyOn(MemoRepository, "markSuperseded").mockResolvedValue(undefined as never)
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(1)
    expect(markSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      ["memo_nearest", "memo_farther"],
      expect.stringContaining("Superseded by revised capture")
    )
    expect(insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ parentMemoId: "memo_nearest" }))
  })
})

describe("MemoService.processBatch — settle gate (active conversations defer until they settle)", () => {
  afterEach(() => mock.restore())

  it("defers an active conversation touched moments ago instead of memorizing mid-debate", async () => {
    const { service } = setupService({ memoContents: [memoContent] })
    spyOn(ConversationRepository, "findById").mockResolvedValue({
      ...fakeConversation(),
      status: "active",
      lastActivityAt: new Date(),
    } as never)
    const markProcessed = spyOn(PendingItemRepository, "markProcessed").mockResolvedValue(undefined as never)
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result).toEqual({ processed: 0, memosCreated: 0 })
    expect(insert).not.toHaveBeenCalled()
    // The deferred item stays unprocessed so the next batch cycle retries it.
    expect(markProcessed).not.toHaveBeenCalled()
  })

  it("memorizes an active conversation once it has been quiet past the settle window", async () => {
    const { service } = setupService({ memoContents: [memoContent] })
    spyOn(ConversationRepository, "findById").mockResolvedValue({
      ...fakeConversation(),
      status: "active",
      lastActivityAt: new Date(Date.now() - 31 * 60 * 1000),
    } as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(1)
  })

  it("memorizes a resolved conversation immediately regardless of recency", async () => {
    const { service } = setupService({ memoContents: [memoContent] })
    spyOn(ConversationRepository, "findById").mockResolvedValue({
      ...fakeConversation(),
      status: "resolved",
      lastActivityAt: new Date(),
    } as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(1)
  })
})

describe("MemoService.processBatch — memo scope write policy (roadmap 6.4)", () => {
  afterEach(() => mock.restore())

  it("extracts private-scratchpad memos into the owner's user tier", async () => {
    const { service } = setupService({ memoContents: [memoContent] })
    spyOn(StreamRepository, "findById").mockResolvedValue(
      fakeStream({ type: "scratchpad", visibility: "private", createdBy: "usr_owner" })
    )
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)
    const findNearDuplicate = spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue(null)

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "user", scopeUserId: "usr_owner" })
    )
    // Dedup is scoped to the same tier so a private memo can't dedup against a shared one.
    expect(findNearDuplicate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "user", scopeUserId: "usr_owner" })
    )
  })

  it("keeps channel and public-scratchpad memos workspace-scoped", async () => {
    const { service } = setupService({ memoContents: [memoContent] })
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream({ type: "channel", visibility: "public" }))
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "workspace", scopeUserId: null })
    )
  })

  it("resolves the root stream so a thread inside a private scratchpad inherits user scope", async () => {
    const { service } = setupService({ memoContents: [memoContent] })
    // The batch's stream is a thread; its root is the owner's private scratchpad.
    // Without root resolution the thread's own type (not SCRATCHPAD) would fall
    // through to workspace scope, leaking the private memo.
    spyOn(StreamRepository, "findById").mockImplementation((async (_db: unknown, id: string) =>
      id === STREAM_ID
        ? fakeStream({ type: "thread", rootStreamId: "stream_root" })
        : fakeStream({
            id: "stream_root",
            type: "scratchpad",
            visibility: "private",
            createdBy: "usr_owner",
          })) as typeof StreamRepository.findById)
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "user", scopeUserId: "usr_owner" })
    )
  })
})

describe("MemoService.processBatch — explicit supersession (reversed conclusions retire their memo)", () => {
  afterEach(() => mock.restore())

  it("marks the memos named in supersedesMemoIds superseded and links the new memo to the first", async () => {
    const reversal: MemoContent = { ...memoContent, supersedesMemoIds: ["memo_old_a", "memo_old_b"] }
    const { service } = setupService({ memoContents: [reversal] })
    const markSuperseded = spyOn(MemoRepository, "markSuperseded").mockResolvedValue(undefined as never)
    const findNear = spyOn(MemoRepository, "findSameConversationNear").mockResolvedValue([])
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(1)
    expect(markSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      ["memo_old_a", "memo_old_b"],
      expect.stringContaining("Conclusion reversed or replaced")
    )
    expect(insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ parentMemoId: "memo_old_a" }))
    // The embedding fallback excludes the explicitly retired memos.
    expect(findNear).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ excludeIds: ["memo_old_a", "memo_old_b"] })
    )
  })

  it("inserts a correction even when it embeds as a near-duplicate of the memo it supersedes", async () => {
    // The incident shape: a correction of an inverted conclusion shares nearly
    // all its text with the wrong memo, so dedup sees it as a duplicate. The
    // explicitly-superseded memo must never block its own correction.
    const reversal: MemoContent = { ...memoContent, supersedesMemoIds: ["memo_wrong"] }
    const { service } = setupService({ memoContents: [reversal] })
    spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue({
      memo: fakeMemoRow("memo_wrong"),
      distance: 0.08,
    })
    const markSuperseded = spyOn(MemoRepository, "markSuperseded").mockResolvedValue(undefined as never)
    spyOn(MemoRepository, "findSameConversationNear").mockResolvedValue([])
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(result.memosCreated).toBe(1)
    expect(markSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      ["memo_wrong"],
      expect.stringContaining("Conclusion reversed or replaced")
    )
    expect(insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ parentMemoId: "memo_wrong" }))
  })

  it("retires the cited memos but drops the insert when an unrelated memo already covers the correction", async () => {
    const reversal: MemoContent = { ...memoContent, supersedesMemoIds: ["memo_wrong"] }
    const { service, streamEventInsertMany } = setupService({ memoContents: [reversal] })
    spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue({
      memo: fakeMemoRow("memo_unrelated_dupe"),
      distance: 0.1,
    })
    const markSuperseded = spyOn(MemoRepository, "markSuperseded").mockResolvedValue(undefined as never)
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    // The duplicate already carries the corrected knowledge: no new memo row,
    // but the reversed memo must not stay active next to it.
    expect(result.memosCreated).toBe(0)
    expect(insert).not.toHaveBeenCalled()
    expect(streamEventInsertMany).not.toHaveBeenCalled()
    expect(markSuperseded).toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_ID,
      ["memo_wrong"],
      expect.stringContaining("memo_unrelated_dupe")
    )
  })

  it("keeps the explicit parent when the embedding fallback also finds near memos", async () => {
    const reversal: MemoContent = { ...memoContent, supersedesMemoIds: ["memo_old_a"] }
    const { service } = setupService({ memoContents: [reversal] })
    spyOn(MemoRepository, "markSuperseded").mockResolvedValue(undefined as never)
    spyOn(MemoRepository, "findSameConversationNear").mockResolvedValue([
      { memo: fakeMemoRow("memo_paraphrase"), distance: 0.2 },
    ])
    const insert = spyOn(MemoRepository, "insert").mockResolvedValue(undefined as never)

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ parentMemoId: "memo_old_a" }))
  })
})

function fakeMemoRow(id: string, overrides: Partial<import("./repository").Memo> = {}): import("./repository").Memo {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    memoType: "message",
    sourceMessageId: "msg_1",
    sourceConversationId: null,
    title: "Deploys only on Fridays after the smoke suite",
    abstract: "The team deploys only on Fridays, and only after the smoke suite passes.",
    keyPoints: [],
    sourceMessageIds: ["msg_1", "msg_2"],
    participantIds: ["usr_1"],
    knowledgeType: "decision",
    tags: ["deploys"],
    parentMemoId: null,
    status: "active",
    version: 1,
    revisionReason: null,
    authoredByKind: "pipeline",
    sourceSessionId: null,
    scope: "workspace",
    scopeUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    ...overrides,
  }
}

function setupSaveMemo() {
  const clientQuery = mock(async () => ({ rows: [] }))
  const fakeClient = { query: clientQuery } as unknown as PoolClient
  spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withTransaction)

  spyOn(MessageRepository, "findByIdsInStreams").mockResolvedValue(fakeMessages())
  spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
  const findNearDuplicate = spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue(null)
  const insert = spyOn(MemoRepository, "insert").mockImplementation(
    async (_db, params) => fakeMemoRow(params.id, { title: params.title }) as never
  )
  spyOn(MemoRepository, "updateEmbedding").mockResolvedValue(undefined as never)
  const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
  const outboxInsertMany = spyOn(OutboxRepository, "insertMany").mockResolvedValue([] as never)
  const captureEvent: StreamEvent = {
    id: "evt_capture",
    streamId: STREAM_ID,
    sequence: 12n,
    broadcastSequence: 8n,
    eventType: "memos:captured",
    payload: {},
    actorId: null,
    actorType: "system",
    createdAt: new Date(),
  }
  const streamEventInsertMany = spyOn(StreamEventRepository, "insertMany").mockResolvedValue([captureEvent])
  spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(fakeMessages())
  const contextInsertMany = spyOn(StreamContextRepository, "insertMany").mockResolvedValue(0)

  const service = new MemoService({
    pool: {} as never,
    classifier: {} as never,
    memorizer: {} as never,
    embeddingService: { embedBatch: async (texts: string[]) => texts.map(() => [0.4, 0.5]) } as never,
    messageFormatter: {} as never,
  })

  return {
    service,
    clientQuery,
    findNearDuplicate,
    insert,
    streamEventInsertMany,
    outboxInsert,
    outboxInsertMany,
    contextInsertMany,
  }
}

const saveMemoInput = {
  workspaceId: WORKSPACE_ID,
  streamId: STREAM_ID,
  sessionId: "agsess_1",
  sourceStreamIds: [STREAM_ID],
  title: "Deploys only on Fridays after the smoke suite",
  abstract: "The team deploys only on Fridays, and only after the smoke suite passes.",
  keyPoints: ["Smoke suite gates the deploy"],
  tags: ["deploys"],
  knowledgeType: "decision" as const,
  sourceMessageIds: ["msg_1", "msg_2"],
}

describe("MemoService.saveMemo — agent-authored memo (roadmap 6.2)", () => {
  afterEach(() => mock.restore())

  it("inserts an agent memo with session provenance and appends a capture event", async () => {
    const { service, clientQuery, insert, streamEventInsertMany, outboxInsert, outboxInsertMany } = setupSaveMemo()

    const result = await service.saveMemo(saveMemoInput)

    expect(result).toMatchObject({ ok: true, deduped: false })
    // Serialized on the same per-stream lock the batch takes (INV-20).
    expect(clientQuery).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(hashtext($1))", [`memo-batch:${STREAM_ID}`])
    // Message-sourced, agent-authored, session provenance, participants from sources.
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        memoType: "message",
        sourceMessageId: "msg_1",
        sourceMessageIds: ["msg_1", "msg_2"],
        authoredByKind: "agent",
        sourceSessionId: "agsess_1",
        participantIds: ["usr_1"],
        status: "active",
      })
    )
    // memo:created rides the outbox.
    expect(outboxInsert).toHaveBeenCalledWith(
      expect.anything(),
      "memo:created",
      expect.objectContaining({ workspaceId: WORKSPACE_ID })
    )
    // Visible in situ (INV-62): capture event on the stream, no conversationId.
    expect(streamEventInsertMany).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        streamId: STREAM_ID,
        eventType: "memos:captured",
        actorType: "system",
        payload: {
          memos: [
            expect.objectContaining({
              memoId: expect.stringMatching(/^memo_/),
              title: saveMemoInput.title,
              knowledgeType: "decision",
              sourceMessageIds: ["msg_1", "msg_2"],
            }),
          ],
        },
      }),
    ])
    expect(streamEventInsertMany.mock.calls[0][1][0].payload).not.toHaveProperty("conversationId")
    expect(outboxInsertMany).toHaveBeenCalledWith(expect.anything(), [
      { eventType: "stream:memos_captured", payload: expect.objectContaining({ streamId: STREAM_ID }) },
    ])
  })

  it("defaults a save in a shared stream to workspace scope (roadmap 6.4)", async () => {
    const { service, insert } = setupSaveMemo()

    await service.saveMemo(saveMemoInput)

    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "workspace", scopeUserId: null })
    )
  })

  it("files an explicit user-scope save under the invoking user (roadmap 6.4)", async () => {
    const { service, insert, findNearDuplicate } = setupSaveMemo()

    await service.saveMemo({ ...saveMemoInput, scope: "user", invokingUserId: "usr_human" })

    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "user", scopeUserId: "usr_human" })
    )
    // Dedup runs in the same tier so a private save can't dedup against a shared memo.
    expect(findNearDuplicate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "user", scopeUserId: "usr_human" })
    )
  })

  it("falls back to workspace scope when a user-scope save has no invoking user", async () => {
    const { service, insert } = setupSaveMemo()

    await service.saveMemo({ ...saveMemoInput, scope: "user", invokingUserId: null })

    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "workspace", scopeUserId: null })
    )
  })

  it("suppresses the capture broadcast for a private save into a shared stream (no title leak)", async () => {
    // Default fakeStream() is a public channel (natural tier workspace); an
    // explicit user-scope override there must NOT broadcast the memo title to the
    // channel via the per-stream memos:captured event (roadmap 6.4 privacy).
    const { service, streamEventInsertMany, outboxInsertMany, insert } = setupSaveMemo()

    const result = await service.saveMemo({ ...saveMemoInput, scope: "user", invokingUserId: "usr_human" })

    expect(result).toMatchObject({ ok: true })
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "user", scopeUserId: "usr_human" })
    )
    expect(streamEventInsertMany).not.toHaveBeenCalled()
    expect(outboxInsertMany).not.toHaveBeenCalled()
  })

  it("still broadcasts the capture for a user-scope save in the owner's own private scratchpad", async () => {
    const { service, streamEventInsertMany } = setupSaveMemo()
    // Audience == owner, so the capture is visible in situ (INV-62) as normal.
    spyOn(StreamRepository, "findById").mockResolvedValue(
      fakeStream({ type: "scratchpad", visibility: "private", createdBy: "usr_owner" })
    )

    await service.saveMemo({ ...saveMemoInput, scope: "user", invokingUserId: "usr_owner" })

    expect(streamEventInsertMany).toHaveBeenCalled()
  })

  it("inherits the private-scratchpad owner tier when no scope is passed", async () => {
    const { service, insert } = setupSaveMemo()
    spyOn(StreamRepository, "findById").mockResolvedValue(
      fakeStream({ type: "scratchpad", visibility: "private", createdBy: "usr_owner" })
    )

    await service.saveMemo(saveMemoInput)

    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "user", scopeUserId: "usr_owner" })
    )
  })

  it("returns the existing memo without inserting when the knowledge is already captured", async () => {
    const { service, insert, streamEventInsertMany, outboxInsert } = setupSaveMemo()
    spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue({
      memo: fakeMemoRow("memo_existing", { title: "Existing" }),
      distance: 0.02,
    })

    const result = await service.saveMemo(saveMemoInput)

    expect(result).toEqual({ ok: true, memoId: "memo_existing", title: "Existing", deduped: true })
    expect(insert).not.toHaveBeenCalled()
    expect(streamEventInsertMany).not.toHaveBeenCalled()
    expect(outboxInsert).not.toHaveBeenCalled()
  })

  it("rejects a save with no source messages before touching the database", async () => {
    const { service, insert } = setupSaveMemo()
    const withTx = spyOn(dbModule, "withTransaction")

    const result = await service.saveMemo({ ...saveMemoInput, sourceMessageIds: [] })

    expect(result).toEqual({ ok: false, reason: "no_source_messages" })
    expect(insert).not.toHaveBeenCalled()
    expect(withTx).not.toHaveBeenCalled()
  })

  it("scopes the source-message fetch to the turn's stream family (INV-8/INV-62)", async () => {
    const { service } = setupSaveMemo()
    const findByIdsInStreams = spyOn(MessageRepository, "findByIdsInStreams").mockResolvedValue(fakeMessages())

    await service.saveMemo({ ...saveMemoInput, sourceStreamIds: [STREAM_ID], sourceMessageIds: ["msg_1", "msg_2"] })

    // The fetch is bounded to the passed stream family, never the whole workspace.
    expect(findByIdsInStreams).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, ["msg_1", "msg_2"], [STREAM_ID])
  })

  it("drops a cited source id outside the turn's stream family (INV-62 — no access widening)", async () => {
    const { service, insert } = setupSaveMemo()
    // Only msg_1 belongs to the turn's stream; msg_wide (a broader stream the user
    // can also see) is not returned by the stream-family-scoped fetch, so it can't
    // widen the memo's inherited retrieval access.
    spyOn(MessageRepository, "findByIdsInStreams").mockResolvedValue(
      new Map([["msg_1", { id: "msg_1", authorId: "usr_1", authorType: "user" } as never]])
    )

    const result = await service.saveMemo({ ...saveMemoInput, sourceMessageIds: ["msg_1", "msg_wide"] })

    expect(result).toMatchObject({ ok: true, deduped: false })
    // The out-of-family id is never persisted; only the in-stream id anchors the memo.
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceMessageId: "msg_1", sourceMessageIds: ["msg_1"], participantIds: ["usr_1"] })
    )
  })

  it("rejects when no cited source message belongs to the turn's stream (INV-62)", async () => {
    const { service, insert } = setupSaveMemo()
    spyOn(MessageRepository, "findByIdsInStreams").mockResolvedValue(new Map())

    const result = await service.saveMemo({ ...saveMemoInput, sourceMessageIds: ["msg_elsewhere"] })

    expect(result).toEqual({ ok: false, reason: "no_source_messages" })
    expect(insert).not.toHaveBeenCalled()
  })
})

function setupReflection(opts: { classification?: Partial<ConversationClassification>; memoContents?: MemoContent[] }) {
  const clientQuery = mock(async () => ({ rows: [] }))
  const fakeClient = { query: clientQuery } as unknown as PoolClient
  spyOn(dbModule, "withClient").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withClient)
  spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: PoolClient) => unknown) =>
    fn(fakeClient)) as typeof dbModule.withTransaction)

  spyOn(MemoRepository, "findByStream").mockResolvedValue([])
  spyOn(MemoRepository, "getAllTags").mockResolvedValue([])
  spyOn(WorkspaceSettingsRepository, "findOverrides").mockResolvedValue([])
  const findNearDuplicate = spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue(null)
  const insert = spyOn(MemoRepository, "insert").mockImplementation(
    async (_db, params) => fakeMemoRow(params.id, { title: params.title }) as never
  )
  spyOn(MemoRepository, "updateEmbedding").mockResolvedValue(undefined as never)
  const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
  const outboxInsertMany = spyOn(OutboxRepository, "insertMany").mockResolvedValue([] as never)
  const captureEvent: StreamEvent = {
    id: "evt_reflect",
    streamId: STREAM_ID,
    sequence: 20n,
    broadcastSequence: 11n,
    eventType: "memos:captured",
    payload: {},
    actorId: null,
    actorType: "system",
    createdAt: new Date(),
  }
  const streamEventInsertMany = spyOn(StreamEventRepository, "insertMany").mockResolvedValue([captureEvent])
  spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
  spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(
    new Map([
      [
        "msg_trigger",
        {
          id: "msg_trigger",
          workspaceId: WORKSPACE_ID,
          streamId: STREAM_ID,
          authorId: "usr_1",
          authorType: "user",
          sequence: 5n,
          createdAt: new Date("2026-07-01T11:00:00.000Z"),
        } as unknown as Message,
      ],
    ])
  )
  const contextInsertMany = spyOn(StreamContextRepository, "insertMany").mockResolvedValue(0)

  const classifyConversation = mock(async () => ({
    isKnowledgeWorthy: true,
    shouldReviseExisting: false,
    revisionReason: null,
    confidence: 0.9,
    containsActionItems: false,
    ...opts.classification,
  }))
  const memorizeConversation = mock(async () => opts.memoContents ?? [memoContent])

  const service = new MemoService({
    pool: {} as never,
    classifier: { classifyConversation } as never,
    memorizer: { memorizeConversation, reviseMemo: async () => [] } as never,
    embeddingService: { embedBatch: async (texts: string[]) => texts.map(() => [0.3, 0.6]) } as never,
    messageFormatter: {} as never,
  })

  return {
    service,
    clientQuery,
    insert,
    findNearDuplicate,
    streamEventInsertMany,
    outboxInsert,
    outboxInsertMany,
    contextInsertMany,
    classifyConversation,
    memorizeConversation,
  }
}

const reflectionInput = {
  workspaceId: WORKSPACE_ID,
  streamId: STREAM_ID,
  sessionId: "agsess_reflect",
  digest: "Trigger message:\nhow do we deploy?\n\nWhat the assistant researched:\nDeploys run Fridays after smoke.",
  anchorMessageId: "msg_trigger",
  participantIds: ["usr_1"],
}

describe("MemoService.captureSessionReflection — reflective capture (roadmap 6.3)", () => {
  afterEach(() => mock.restore())

  it("captures agent memos anchored to the session's message with session provenance + capture event", async () => {
    const { service, clientQuery, insert, streamEventInsertMany, outboxInsert, outboxInsertMany } = setupReflection({})

    const result = await service.captureSessionReflection(reflectionInput)

    expect(result).toEqual({ classified: true, captured: 1, deduped: 0 })
    // Serialized on the same per-stream lock the batch/save_memo take (INV-20).
    expect(clientQuery).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(hashtext($1))", [`memo-batch:${STREAM_ID}`])
    // Message-sourced (anchored to the session's own message), agent-authored, session provenance.
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        memoType: "message",
        sourceMessageId: "msg_trigger",
        sourceMessageIds: ["msg_trigger"],
        authoredByKind: "agent",
        sourceSessionId: "agsess_reflect",
        participantIds: ["usr_1"],
        status: "active",
      })
    )
    expect(outboxInsert).toHaveBeenCalledWith(
      expect.anything(),
      "memo:created",
      expect.objectContaining({ workspaceId: WORKSPACE_ID })
    )
    // Visible in situ (INV-62): capture event on the session's stream, no conversationId.
    expect(streamEventInsertMany).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({
        streamId: STREAM_ID,
        eventType: "memos:captured",
        actorType: "system",
        payload: {
          memos: [
            expect.objectContaining({ memoId: expect.stringMatching(/^memo_/), sourceMessageIds: ["msg_trigger"] }),
          ],
        },
      }),
    ])
    expect(streamEventInsertMany.mock.calls[0][1][0].payload).not.toHaveProperty("conversationId")
    expect(outboxInsertMany).toHaveBeenCalledWith(expect.anything(), [
      { eventType: "stream:memos_captured", payload: expect.objectContaining({ streamId: STREAM_ID }) },
    ])
  })

  it("does not memorize or write when the classifier judges the digest not worthy", async () => {
    const { service, insert, memorizeConversation, streamEventInsertMany } = setupReflection({
      classification: { isKnowledgeWorthy: false },
    })

    const result = await service.captureSessionReflection(reflectionInput)

    expect(result).toEqual({ classified: false, captured: 0, deduped: 0 })
    expect(memorizeConversation).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(streamEventInsertMany).not.toHaveBeenCalled()
  })

  it("skips when classifier confidence is below the floor", async () => {
    const { service, insert, memorizeConversation } = setupReflection({
      classification: { confidence: 0.4 },
    })

    const result = await service.captureSessionReflection(reflectionInput)

    expect(result).toEqual({ classified: false, captured: 0, deduped: 0 })
    expect(memorizeConversation).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  it("caps captured memos at MEMO_REFLECTIVE_MAX_MEMOS", async () => {
    const many: MemoContent[] = [1, 2, 3].map((n) => ({
      ...memoContent,
      title: `Reflective memo ${n}`,
      abstract: `Distinct durable finding number ${n}.`,
    }))
    const { service, insert } = setupReflection({ memoContents: many })

    const result = await service.captureSessionReflection(reflectionInput)

    expect(result.captured).toBe(MEMO_REFLECTIVE_MAX_MEMOS)
    expect(insert).toHaveBeenCalledTimes(MEMO_REFLECTIVE_MAX_MEMOS)
  })

  it("coerces a disallowed knowledge type to the fallback — agents don't mint decisions (roadmap 6.6)", async () => {
    const { service, insert } = setupReflection({
      memoContents: [
        { ...memoContent, title: "Self-minted ruling", knowledgeType: "decision" },
        { ...memoContent, title: "Genuine finding", abstract: "Distinct second finding.", knowledgeType: "procedure" },
      ],
    })

    const result = await service.captureSessionReflection(reflectionInput)

    expect(result.captured).toBe(2)
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Self-minted ruling", knowledgeType: "learning" })
    )
    // An allowed type passes through untouched.
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Genuine finding", knowledgeType: "procedure" })
    )
  })

  it("dedups a reflective memo whose knowledge already exists in the stream", async () => {
    const { service, insert, streamEventInsertMany } = setupReflection({})
    spyOn(MemoRepository, "findNearDuplicate").mockResolvedValue({
      memo: fakeMemoRow("memo_existing"),
      distance: 0.03,
    })

    const result = await service.captureSessionReflection(reflectionInput)

    expect(result).toEqual({ classified: true, captured: 0, deduped: 1 })
    expect(insert).not.toHaveBeenCalled()
    expect(streamEventInsertMany).not.toHaveBeenCalled()
  })
})

describe("MemoService.processBatch — stream-context projection", () => {
  afterEach(() => mock.restore())

  it("indexes each captured memo at its LATEST source message's created_at", async () => {
    const { service, contextInsertMany } = setupService({ memoContents: [memoContent] })

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    const [row] = contextInsertMany.mock.calls[0]?.[1] as unknown as Array<Record<string, unknown>>
    const { id, refId, ...rest } = row
    expect(rest).toEqual({
      workspaceId: WORKSPACE_ID,
      streamId: STREAM_ID,
      rootStreamId: STREAM_ID,
      category: "memo",
      refKind: "memo",
      groupKey: refId,
      sourceMessageId: "msg_1",
      authorId: "usr_1",
      occurredAt: new Date("2026-07-01T10:05:00.000Z"),
      sequence: 2n,
      snippet: memoContent.title,
      detail: { title: memoContent.title, knowledgeType: "decision" },
    })
  })

  it("skips the projection for a sealed stream", async () => {
    const { service, contextInsertMany } = setupService({ memoContents: [memoContent] })
    ;(StreamRepository.findById as never as ReturnType<typeof spyOn>).mockResolvedValue(
      fakeStream({ e2eEnabled: true } as never) as never
    )

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(contextInsertMany).not.toHaveBeenCalled()
  })
})

describe("MemoService — stream-context projection privacy + scoping", () => {
  afterEach(() => mock.restore())

  it("resolves source messages workspace-scoped (INV-8)", async () => {
    const { service, findSourceMessages } = setupService({ memoContents: [memoContent] })

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(findSourceMessages).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, ["msg_1", "msg_2"])
  })

  it("writes no projection row for a private save into a shared stream (title would leak)", async () => {
    const { service, contextInsertMany, streamEventInsertMany } = setupSaveMemo()

    await service.saveMemo({ ...saveMemoInput, scope: "user", invokingUserId: "usr_human" })

    expect(streamEventInsertMany).not.toHaveBeenCalled()
    expect(contextInsertMany).not.toHaveBeenCalled()
  })

  it("indexes a user-scope save in the owner's own private scratchpad", async () => {
    const { service, contextInsertMany } = setupSaveMemo()
    spyOn(StreamRepository, "findById").mockResolvedValue(
      fakeStream({ type: "scratchpad", visibility: "private", createdBy: "usr_owner" })
    )

    await service.saveMemo({ ...saveMemoInput, scope: "user", invokingUserId: "usr_owner" })

    expect(contextInsertMany).toHaveBeenCalled()
  })

  it("files a save made inside a thread on the thread's root stream", async () => {
    const { service, contextInsertMany } = setupSaveMemo()
    spyOn(StreamRepository, "findById").mockResolvedValue(
      fakeStream({ id: "stream_thread", type: "thread", rootStreamId: "stream_root" })
    )

    await service.saveMemo(saveMemoInput)

    expect(contextInsertMany.mock.calls[0][1][0]).toMatchObject({
      streamId: "stream_root",
      rootStreamId: "stream_root",
      category: "memo",
    })
  })

  it("writes the projection row for a reflective capture, same transaction as the event", async () => {
    const { service, contextInsertMany, streamEventInsertMany } = setupReflection({})

    await service.captureSessionReflection(reflectionInput)

    expect(streamEventInsertMany).toHaveBeenCalled()
    expect(contextInsertMany.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        streamId: STREAM_ID,
        category: "memo",
        refKind: "memo",
        sourceMessageId: "msg_trigger",
      }),
    ])
  })
})

describe("MemoService.processBatch — re-classification change gate", () => {
  afterEach(() => mock.restore())

  it("classifies a conversation it has never seen and records what it was shown", async () => {
    const { service, classifyConversation, recordFingerprints } = setupService({ memoContents: [memoContent] })

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(classifyConversation).toHaveBeenCalledTimes(1)
    expect(recordFingerprints.mock.calls[0]?.[1]).toEqual([
      { id: "pend_1", fingerprint: expect.any(String) as unknown as string },
    ])
  })

  it("skips the AI call when the conversation is unchanged since that pass", async () => {
    // The digest the previous pass would have stored, derived from the same
    // fakes this batch will load.
    const stored = classificationFingerprint(fakeConversation(), [...fakeMessages().values()], [])
    const { service, classifyConversation, recordFingerprints } = setupService({
      memoContents: [memoContent],
      pendingItem: { classifiedFingerprint: stored },
    })

    const result = await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(classifyConversation).not.toHaveBeenCalled()
    expect(result.memosCreated).toBe(0)
    // Nothing new was asked, so nothing new is recorded — the stored digest still stands.
    expect(recordFingerprints.mock.calls[0]?.[1]).toEqual([])
  })

  it("still marks a skipped item processed, so it does not re-queue forever", async () => {
    const stored = classificationFingerprint(fakeConversation(), [...fakeMessages().values()], [])
    const { service } = setupService({
      memoContents: [memoContent],
      pendingItem: { classifiedFingerprint: stored },
    })
    const markProcessed = PendingItemRepository.markProcessed as unknown as ReturnType<typeof mock>

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(markProcessed.mock.calls[0]?.[1]).toEqual(["pend_1"])
  })

  it("classifies again when the stored digest is stale", async () => {
    const { service, classifyConversation } = setupService({
      memoContents: [memoContent],
      pendingItem: { classifiedFingerprint: "digest-from-before-the-last-two-messages" },
    })

    await service.processBatch(WORKSPACE_ID, STREAM_ID)

    expect(classifyConversation).toHaveBeenCalledTimes(1)
  })
})
