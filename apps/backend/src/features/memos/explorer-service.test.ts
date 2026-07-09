import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { MemoExplorerService } from "./explorer-service"
import { MemoRepository, type Memo } from "./repository"
import { MessageRepository } from "../messaging"
import { StreamRepository, type Stream } from "../streams"
import * as dbModule from "../../db"
import type { EmbeddingServiceLike } from "./embedding-service"
import type { RerankerLike } from "./reranker"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"
const MEMO_ID = "memo_1"

function fakeMemo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: MEMO_ID,
    workspaceId: WORKSPACE_ID,
    memoType: "message",
    sourceMessageId: "msg_1",
    sourceConversationId: null,
    title: "Original title",
    abstract: "Original abstract",
    keyPoints: ["one"],
    sourceMessageIds: [],
    participantIds: [],
    knowledgeType: "decision",
    tags: ["a"],
    parentMemoId: null,
    status: "active",
    version: 1,
    revisionReason: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    archivedAt: null,
    ...overrides,
  }
}

function fakeStream(): Stream {
  return {
    id: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    type: "channel",
    slug: "general",
    displayName: "general",
    rootStreamId: null,
  } as unknown as Stream
}

function buildService() {
  const embed = mock(async () => [0.42])
  const embeddingService = { embed, embedBatch: mock(async () => [[0.42]]) } as unknown as EmbeddingServiceLike
  const reranker = { rerank: mock(async (_q, c: unknown[]) => c.map((_, i) => i)) } as unknown as RerankerLike
  const service = new MemoExplorerService({
    pool: {} as unknown as Pool,
    embeddingService,
    reranker,
  })
  return { service, embed }
}

function stubSourceStreamResolution() {
  spyOn(MessageRepository, "findById").mockResolvedValue({ streamId: STREAM_ID } as never)
  spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream() as never)
  spyOn(MessageRepository, "findByIds").mockResolvedValue(new Map())
}

const ACCESS = { accessibleStreamIds: [STREAM_ID] }
const NO_ACCESS = { accessibleStreamIds: ["stream_other"] }

afterEach(() => {
  mock.restore()
})

describe("MemoExplorerService.update (roadmap 6.1)", () => {
  it("re-embeds when the abstract changes and persists both in one transaction", async () => {
    const { service, embed } = buildService()
    stubSourceStreamResolution()
    spyOn(MemoRepository, "findById").mockResolvedValue(fakeMemo())
    const updated = fakeMemo({ abstract: "New abstract" })
    const updateSpy = spyOn(MemoRepository, "update").mockResolvedValue(updated)
    const embeddingSpy = spyOn(MemoRepository, "updateEmbedding").mockResolvedValue(undefined)
    spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: unknown) => unknown) =>
      fn({} as never)) as typeof dbModule.withTransaction)

    const result = await service.update(WORKSPACE_ID, MEMO_ID, ACCESS, { abstract: "New abstract" })

    expect(result?.memo.abstract).toBe("New abstract")
    expect(embed).toHaveBeenCalledTimes(1)
    expect(embeddingSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith(expect.anything(), MEMO_ID, {
      title: undefined,
      abstract: "New abstract",
      keyPoints: undefined,
      tags: undefined,
    })
  })

  it("does not re-embed for a title-only edit (abstract absent from the update)", async () => {
    const { service, embed } = buildService()
    stubSourceStreamResolution()
    spyOn(MemoRepository, "findById").mockResolvedValue(fakeMemo())
    spyOn(MemoRepository, "update").mockResolvedValue(fakeMemo({ title: "Renamed" }))
    const embeddingSpy = spyOn(MemoRepository, "updateEmbedding").mockResolvedValue(undefined)
    spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: unknown) => unknown) =>
      fn({} as never)) as typeof dbModule.withTransaction)

    await service.update(WORKSPACE_ID, MEMO_ID, ACCESS, { title: "Renamed" })

    expect(embed).not.toHaveBeenCalled()
    expect(embeddingSpy).not.toHaveBeenCalled()
  })

  it("re-embeds whenever the abstract is in the update, keeping abstract and embedding consistent", async () => {
    const { service, embed } = buildService()
    stubSourceStreamResolution()
    spyOn(MemoRepository, "findById").mockResolvedValue(fakeMemo())
    spyOn(MemoRepository, "update").mockResolvedValue(fakeMemo())
    const embeddingSpy = spyOn(MemoRepository, "updateEmbedding").mockResolvedValue(undefined)
    spyOn(dbModule, "withTransaction").mockImplementation((async (_pool: unknown, fn: (c: unknown) => unknown) =>
      fn({} as never)) as typeof dbModule.withTransaction)

    // Same text as the stored abstract — still re-embeds, because the decision
    // is "is the abstract being written" not a diff against a pre-read value.
    await service.update(WORKSPACE_ID, MEMO_ID, ACCESS, { abstract: "Original abstract" })

    expect(embed).toHaveBeenCalledTimes(1)
    expect(embeddingSpy).toHaveBeenCalledTimes(1)
  })

  it("returns null when the source stream is not accessible", async () => {
    const { service } = buildService()
    stubSourceStreamResolution()
    spyOn(MemoRepository, "findById").mockResolvedValue(fakeMemo())
    const updateSpy = spyOn(MemoRepository, "update").mockResolvedValue(fakeMemo())

    const result = await service.update(WORKSPACE_ID, MEMO_ID, NO_ACCESS, { title: "x" })

    expect(result).toBeNull()
    expect(updateSpy).not.toHaveBeenCalled()
  })
})

describe("MemoExplorerService.archive / unarchive (roadmap 6.1)", () => {
  it("archives an accessible memo", async () => {
    const { service } = buildService()
    stubSourceStreamResolution()
    spyOn(MemoRepository, "findById").mockResolvedValue(fakeMemo())
    const archiveSpy = spyOn(MemoRepository, "archive").mockResolvedValue(fakeMemo({ status: "archived" }))

    const result = await service.archive(WORKSPACE_ID, MEMO_ID, ACCESS)

    expect(result?.memo.status).toBe("archived")
    expect(archiveSpy).toHaveBeenCalledWith(expect.anything(), MEMO_ID)
  })

  it("returns null when unarchive finds no archived row to restore", async () => {
    const { service } = buildService()
    stubSourceStreamResolution()
    spyOn(MemoRepository, "findById").mockResolvedValue(fakeMemo({ status: "superseded" }))
    spyOn(MemoRepository, "unarchive").mockResolvedValue(null)

    const result = await service.unarchive(WORKSPACE_ID, MEMO_ID, ACCESS)

    expect(result).toBeNull()
  })

  it("returns null when archive is a no-op (repo guard rejects a non-active memo)", async () => {
    const { service } = buildService()
    stubSourceStreamResolution()
    spyOn(MemoRepository, "findById").mockResolvedValue(fakeMemo({ status: "superseded" }))
    // The repo's `WHERE status = 'active'` guard makes archiving a superseded memo a no-op.
    spyOn(MemoRepository, "archive").mockResolvedValue(null)

    const result = await service.archive(WORKSPACE_ID, MEMO_ID, ACCESS)

    expect(result).toBeNull()
  })
})

describe("MemoExplorerService.getById (roadmap 6.1)", () => {
  it("returns archived memos (status is no longer gated) with a successor link when superseded", async () => {
    const { service } = buildService()
    stubSourceStreamResolution()
    spyOn(MemoRepository, "findById").mockResolvedValue(fakeMemo({ status: "superseded" }))
    spyOn(MemoRepository, "findSupersededBy").mockResolvedValue(fakeMemo({ id: "memo_2" }))

    const result = await service.getById(WORKSPACE_ID, MEMO_ID, ACCESS)

    expect(result?.memo.status).toBe("superseded")
    expect(result?.successorMemoId).toBe("memo_2")
  })
})
