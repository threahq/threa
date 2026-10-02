import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { setupTestDatabase, withClient, withTransaction } from "./setup"
import { MemoRepository, PendingItemRepository } from "../../src/features/memos"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { conversationId, memoId, messageId, pendingItemId, streamId, userId, workspaceId } from "../../src/lib/id"

const EMBEDDING_DIM = 1536

/** Cosine distance between `vec(1)` and `vec(1, y)` grows with y; `vec(0, 1)` is orthogonal to `vec(1)`. */
function vec(x: number, y = 0): number[] {
  return [x, y, ...new Array(EMBEDDING_DIM - 2).fill(0)]
}

const searchToken = () => `scopetok${Math.random().toString(36).slice(2, 12)}`

interface MemoSeed {
  message?: string
  conversation?: string
  sourceMessageIds?: string[]
  title?: string
  abstract?: string
  tags?: string[]
  status?: string
  parent?: string
  embedding?: number[]
  searchConfig?: string | null
  createdAt?: Date
}

describe("Memo and pending-item repositories workspace scope (INV-8)", () => {
  let pool: Pool
  const author = userId()

  async function insertRow(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row)
    await pool.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row)
    )
  }

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Memo scope ${label}`,
        slug: `memo-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    return id
  }

  async function seedPair() {
    return { wsA: await seedWorkspace("a"), wsB: await seedWorkspace("b") }
  }

  async function addStream(
    wid: string,
    seed: { type?: "channel" | "thread"; visibility?: "public" | "private"; root?: string } = {}
  ) {
    const id = streamId()
    await insertRow("streams", {
      id,
      workspace_id: wid,
      type: seed.type ?? "channel",
      visibility: seed.visibility ?? "public",
      slug: `memo-scope-${id}`,
      created_by: author,
      parent_stream_id: seed.root ?? null,
      root_stream_id: seed.root ?? null,
    })
    return id
  }

  async function addMessage(wid: string, stream: string, content = "message") {
    const id = messageId()
    await insertRow("messages", {
      id,
      workspace_id: wid,
      stream_id: stream,
      sequence: 0,
      author_id: author,
      author_type: "user",
      content_markdown: content,
      content_json: JSON.stringify({ type: "doc", content: [] }),
    })
    return id
  }

  async function addConversation(wid: string, stream: string) {
    const id = conversationId()
    await insertRow("conversations", { id, workspace_id: wid, stream_id: stream })
    return id
  }

  async function addMemo(wid: string, seed: MemoSeed) {
    const id = memoId()
    await insertRow("memos", {
      id,
      workspace_id: wid,
      memo_type: seed.message ? "message" : "conversation",
      source_message_id: seed.message ?? null,
      source_conversation_id: seed.conversation ?? null,
      title: seed.title ?? `title ${id}`,
      abstract: seed.abstract ?? `abstract ${id}`,
      source_message_ids: seed.sourceMessageIds ?? [],
      participant_ids: [author],
      knowledge_type: "decision",
      tags: seed.tags ?? [],
      status: seed.status ?? "active",
      archived_at: seed.status === "archived" ? new Date() : null,
      parent_memo_id: seed.parent ?? null,
      embedding: seed.embedding ? `[${seed.embedding.join(",")}]` : null,
      search_config: seed.searchConfig === undefined ? "simple" : seed.searchConfig,
      ...(seed.createdAt ? { created_at: seed.createdAt } : {}),
    })
    return id
  }

  async function addPending(wid: string, stream: string, seed: { queuedAt?: Date } = {}) {
    const id = pendingItemId()
    await insertRow("memo_pending_items", {
      id,
      workspace_id: wid,
      stream_id: stream,
      item_type: "message",
      item_id: messageId(),
      queued_at: seed.queuedAt ?? new Date(),
    })
    return id
  }

  async function memoRows(ids: string[]) {
    const result = await pool.query(
      `SELECT id, workspace_id, title, status, revision_reason, archived_at, search_config, updated_at,
              embedding IS NOT NULL AS has_embedding
       FROM memos WHERE id = ANY($1)`,
      [ids]
    )
    return ids.map((id) => result.rows.find((row) => row.id === id))
  }

  async function pendingRows(ids: string[]) {
    const result = await pool.query(
      `SELECT id, workspace_id, processed_at IS NOT NULL AS processed, classified_fingerprint
       FROM memo_pending_items WHERE id = ANY($1)`,
      [ids]
    )
    return ids.map((id) => result.rows.find((row) => row.id === id))
  }

  function streamsOf(
    results: Array<{ memo: { id: string }; sourceStream: { id: string } | null; rootStream: { id: string } | null }>
  ) {
    return Object.fromEntries(
      results.map((r) => [r.memo.id, { source: r.sourceStream?.id ?? null, root: r.rootStream?.id ?? null }])
    )
  }

  /**
   * Memos in workspace A that resolve to real streams, plus A memos whose source chain points into workspace B
   * (so any dropped join pin makes the chain resolve), plus a B memo with a fully-B chain. All carry `token`.
   */
  async function seedSearchWorld(wsA: string, wsB: string, token: string) {
    const embedding = vec(1, 0.3)
    const chanA = await addStream(wsA)
    const threadA = await addStream(wsA, { type: "thread", visibility: "private", root: chanA })
    const chanB = await addStream(wsB)
    const threadOfB = await addStream(wsA, { type: "thread", visibility: "private", root: chanB })
    const common = { title: `${token} title`, abstract: `${token} abstract`, embedding }

    const legitChan = await addMemo(wsA, { ...common, message: await addMessage(wsA, chanA) })
    const legitThread = await addMemo(wsA, { ...common, message: await addMessage(wsA, threadA) })
    const legitConv = await addMemo(wsA, { ...common, conversation: await addConversation(wsA, chanA) })
    const msgInB = await addMessage(wsB, chanA)
    const convInB = await addConversation(wsB, chanA)
    const viaForeignMessage = await addMemo(wsA, { ...common, message: msgInB })
    const viaForeignMessageStream = await addMemo(wsA, { ...common, message: await addMessage(wsA, chanB) })
    const viaForeignConversation = await addMemo(wsA, { ...common, conversation: convInB })
    const viaForeignConversationStream = await addMemo(wsA, {
      ...common,
      conversation: await addConversation(wsA, chanB),
    })
    const viaForeignRoot = await addMemo(wsA, { ...common, message: await addMessage(wsA, threadOfB) })
    await addMemo(wsB, { ...common, message: await addMessage(wsB, chanB) })

    return {
      expected: {
        [legitChan]: { source: chanA, root: null },
        [legitThread]: { source: threadA, root: chanA },
        [legitConv]: { source: chanA, root: null },
        [viaForeignMessage]: { source: null, root: null },
        [viaForeignMessageStream]: { source: null, root: null },
        [viaForeignConversation]: { source: null, root: null },
        [viaForeignConversationStream]: { source: null, root: null },
        [viaForeignRoot]: { source: threadOfB, root: null },
      },
    }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("reads by id", () => {
    test("should return null when findById is given a memo id from another workspace", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const own = await addMemo(wsA, { message: await addMessage(wsA, stream) })
      const foreign = await addMemo(wsB, { message: await addMessage(wsB, await addStream(wsB)) })

      expect({
        own: (await MemoRepository.findById(pool, wsA, own))?.id,
        foreign: await MemoRepository.findById(pool, wsA, foreign),
      }).toEqual({ own, foreign: null })
    })

    test("should return null when findByIdForUpdate is given a memo id from another workspace", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, { message: await addMessage(wsA, await addStream(wsA)) })
      const foreign = await addMemo(wsB, { message: await addMessage(wsB, await addStream(wsB)) })

      const found = await withTransaction(pool, async (client) => ({
        own: (await MemoRepository.findByIdForUpdate(client, wsA, own))?.id,
        foreign: await MemoRepository.findByIdForUpdate(client, wsA, foreign),
      }))

      expect(found).toEqual({ own, foreign: null })
    })

    test("should leave out memos from another workspace when findByIdsInWorkspace is given their ids", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, { message: await addMessage(wsA, await addStream(wsA)) })
      const foreign = await addMemo(wsB, { message: await addMessage(wsB, await addStream(wsB)) })

      const found = await MemoRepository.findByIdsInWorkspace(pool, wsA, [own, foreign])

      expect([...found.keys()]).toEqual([own])
    })

    test("should leave out another workspace's memo when findSupersededBy has a newer foreign memo pointing at the parent", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const parent = await addMemo(wsA, { message: await addMessage(wsA, stream), status: "superseded" })
      const successor = await addMemo(wsA, {
        message: await addMessage(wsA, stream),
        parent,
        createdAt: new Date("2000-01-01T00:00:00Z"),
      })
      await addMemo(wsB, {
        message: await addMessage(wsB, await addStream(wsB)),
        parent,
        createdAt: new Date("2000-01-02T00:00:00Z"),
      })

      const found = await MemoRepository.findSupersededBy(pool, wsA, parent)

      expect(found?.id).toEqual(successor)
    })

    test("should list only the workspace's tags when getAllTags runs beside another workspace's memos", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      await addMemo(wsA, { message: await addMessage(wsA, stream), tags: ["alpha", "bravo"] })
      await addMemo(wsB, { message: await addMessage(wsB, await addStream(wsB)), tags: ["charlie"] })

      expect(await MemoRepository.getAllTags(pool, wsA, { scopeUserId: null, rootStreamId: stream })).toEqual([
        "alpha",
        "bravo",
      ])
    })
  })

  describe("reads that resolve a source stream", () => {
    test("should summarise only memos whose whole source chain sits in the workspace when findEmbedSummaries meets decoys", async () => {
      const { wsA, wsB } = await seedPair()
      const citing = await addStream(wsA, { visibility: "private" })
      const publicA = await addStream(wsA)
      const publicB = await addStream(wsB)
      const threadOfB = await addStream(wsA, { type: "thread", visibility: "private", root: publicB })

      const legitMessage = await addMemo(wsA, { message: await addMessage(wsA, publicA) })
      const legitConversation = await addMemo(wsA, { conversation: await addConversation(wsA, publicA) })
      const legitFirstMessage = await addMemo(wsA, {
        conversation: conversationId(),
        sourceMessageIds: [await addMessage(wsA, publicA)],
      })
      const viaForeignMessage = await addMemo(wsA, { message: await addMessage(wsB, publicA) })
      const viaForeignConversation = await addMemo(wsA, { conversation: await addConversation(wsB, publicA) })
      const viaForeignFirstMessage = await addMemo(wsA, {
        conversation: conversationId(),
        sourceMessageIds: [await addMessage(wsB, publicA)],
      })
      const viaForeignStream = await addMemo(wsA, { message: await addMessage(wsA, publicB) })
      const viaForeignRoot = await addMemo(wsA, { message: await addMessage(wsA, threadOfB) })
      const foreign = await addMemo(wsB, { message: await addMessage(wsB, publicB) })

      const summaries = await MemoRepository.findEmbedSummaries(
        pool,
        wsA,
        [
          legitMessage,
          legitConversation,
          legitFirstMessage,
          viaForeignMessage,
          viaForeignConversation,
          viaForeignFirstMessage,
          viaForeignStream,
          viaForeignRoot,
          foreign,
        ],
        citing
      )

      expect([...summaries.keys()].sort()).toEqual([legitMessage, legitConversation, legitFirstMessage].sort())
    })

    test("should list only the workspace's citing streams when findCitingStreamIds sees a foreign message citing the memo", async () => {
      const { wsA, wsB } = await seedPair()
      const citingStream = await addStream(wsA)
      const otherStream = await addStream(wsA)
      const memo = await addMemo(wsA, { message: await addMessage(wsA, citingStream) })
      await addMessage(wsA, citingStream, `see [it](memo:${memo})`)
      await addMessage(wsB, otherStream, `see [it](memo:${memo})`)

      expect(await MemoRepository.findCitingStreamIds(pool, wsA, memo)).toEqual([citingStream])
    })

    test("should return only the stream's memos when findByStream meets rows from another workspace on both source paths", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const day = (n: number) => new Date(Date.UTC(2000, 0, 1 + n))
      const viaConversation = await addMemo(wsA, {
        conversation: await addConversation(wsA, stream),
        createdAt: day(2),
      })
      const viaMessage = await addMemo(wsA, { message: await addMessage(wsA, stream), createdAt: day(1) })
      await addMemo(wsA, { conversation: await addConversation(wsB, stream), createdAt: day(3) })
      await addMemo(wsB, { conversation: await addConversation(wsB, stream), createdAt: day(4) })
      await addMemo(wsA, { message: await addMessage(wsB, stream), createdAt: day(5) })
      await addMemo(wsB, { message: await addMessage(wsB, stream), createdAt: day(6) })

      const found = await MemoRepository.findByStream(pool, wsA, stream, { scopeUserId: null })

      expect(found.map((memo) => memo.id)).toEqual([viaConversation, viaMessage])
    })

    test("should return only the workspace's conversations when findConversationIdsWithMemos meets a foreign memo on a workspace conversation", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const captured = await addConversation(wsA, stream)
      const onlyForeignMemo = await addConversation(wsA, stream)
      await addMemo(wsA, { conversation: captured })
      await addMemo(wsB, { conversation: onlyForeignMemo })

      const found = await MemoRepository.findConversationIdsWithMemos(pool, wsA, [captured, onlyForeignMemo])

      expect([...found]).toEqual([captured])
    })

    test("should return only the workspace's memos when findActiveBySourceConversation meets a foreign memo on the same conversation", async () => {
      const { wsA, wsB } = await seedPair()
      const conversation = await addConversation(wsA, await addStream(wsA))
      const own = await addMemo(wsA, { conversation })
      await addMemo(wsB, { conversation })

      const found = await MemoRepository.findActiveBySourceConversation(pool, wsA, conversation)

      expect(found.map((memo) => memo.id)).toEqual([own])
    })
  })

  describe("nearest-neighbour reads", () => {
    test("should return the nearest workspace memo when findNearDuplicate meets nearer rows from another workspace on both source paths", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const nearest = await addMemo(wsA, {
        conversation: await addConversation(wsA, stream),
        embedding: vec(1, 0.1),
      })
      await addMemo(wsA, { conversation: await addConversation(wsB, stream), embedding: vec(1) })
      await addMemo(wsB, { conversation: await addConversation(wsB, stream), embedding: vec(1) })
      await addMemo(wsA, { message: await addMessage(wsB, stream), embedding: vec(1) })
      await addMemo(wsB, { message: await addMessage(wsB, stream), embedding: vec(1) })

      const found = await MemoRepository.findNearDuplicate(pool, {
        workspaceId: wsA,
        streamId: stream,
        embedding: vec(1),
        maxDistance: 0.3,
      })

      expect(found?.memo.id).toEqual(nearest)
    })

    test("should return only the workspace's memos when findSameConversationNear meets a nearer foreign memo on the conversation", async () => {
      const { wsA, wsB } = await seedPair()
      const conversation = await addConversation(wsA, await addStream(wsA))
      const own = await addMemo(wsA, { conversation, embedding: vec(1, 0.1) })
      await addMemo(wsB, { conversation, embedding: vec(1) })

      const found = await MemoRepository.findSameConversationNear(pool, {
        workspaceId: wsA,
        conversationId: conversation,
        embedding: vec(1),
        maxDistance: 0.3,
      })

      expect(found.map((row) => row.memo.id)).toEqual([own])
    })
  })

  describe("search", () => {
    test("should list only the workspace's memos with their own streams when fullTextSearch runs without a query", async () => {
      const { wsA, wsB } = await seedPair()
      const world = await seedSearchWorld(wsA, wsB, searchToken())

      const found = await MemoRepository.fullTextSearch(pool, { workspaceId: wsA, query: "" })

      expect(streamsOf(found)).toEqual(world.expected)
    })

    test("should list only the workspace's memos with their own streams when fullTextSearch runs with a query", async () => {
      const { wsA, wsB } = await seedPair()
      const token = searchToken()
      const world = await seedSearchWorld(wsA, wsB, token)

      const found = await MemoRepository.fullTextSearch(pool, { workspaceId: wsA, query: token })

      expect(streamsOf(found)).toEqual(world.expected)
    })

    test("should list only the workspace's memos with their own streams when exactSearch runs with a query", async () => {
      const { wsA, wsB } = await seedPair()
      const token = searchToken()
      const world = await seedSearchWorld(wsA, wsB, token)

      const found = await MemoRepository.exactSearch(pool, { workspaceId: wsA, query: token })

      expect(streamsOf(found)).toEqual(world.expected)
    })

    test("should list only the workspace's memos with their own streams when hybridSearch runs", async () => {
      const { wsA, wsB } = await seedPair()
      const token = searchToken()
      const world = await seedSearchWorld(wsA, wsB, token)

      const found = await MemoRepository.hybridSearch(pool, {
        workspaceId: wsA,
        query: token,
        embedding: vec(1),
        applyStructuralBoost: false,
      })

      expect(streamsOf(found)).toEqual(world.expected)
    })

    test("should rank workspace memos as if other workspaces did not exist when hybridSearch meets foreign memos that win both candidate lists", async () => {
      const { wsA, wsB } = await seedPair()
      const token = searchToken()
      const own = await addMemo(wsA, {
        message: await addMessage(wsA, await addStream(wsA)),
        title: `${token} title`,
        embedding: vec(1, 0.3),
      })
      const chanB = await addStream(wsB)
      await addMemo(wsB, {
        message: await addMessage(wsB, chanB),
        title: `${token} title`,
        abstract: new Array(30).fill(token).join(" "),
        embedding: vec(0, 1),
      })
      await addMemo(wsB, {
        message: await addMessage(wsB, chanB),
        title: "unrelated",
        embedding: vec(1),
      })

      const found = await MemoRepository.hybridSearch(pool, {
        workspaceId: wsA,
        query: token,
        embedding: vec(1),
        applyStructuralBoost: false,
      })

      expect(found.map((row) => ({ id: row.memo.id, distance: Number(row.distance.toFixed(9)) }))).toEqual([
        { id: own, distance: Number((1 / (1 + 1 / 61)).toFixed(9)) },
      ])
    })
  })

  describe("writes by id", () => {
    test("should leave a foreign memo unchanged when markSuperseded is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, { message: await addMessage(wsA, await addStream(wsA)) })
      const foreign = await addMemo(wsB, { message: await addMessage(wsB, await addStream(wsB)) })

      await MemoRepository.markSuperseded(pool, wsA, [own, foreign], "replaced")

      expect(
        (await memoRows([own, foreign])).map((row) => ({
          id: row.id,
          status: row.status,
          revisionReason: row.revision_reason,
        }))
      ).toEqual([
        { id: own, status: "superseded", revisionReason: "replaced" },
        { id: foreign, status: "active", revisionReason: null },
      ])
    })

    test("should leave a foreign memo unchanged when update is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, { message: await addMessage(wsA, await addStream(wsA)), title: "own" })
      const foreign = await addMemo(wsB, {
        message: await addMessage(wsB, await addStream(wsB)),
        title: "foreign",
      })
      const before = await memoRows([foreign])

      const results = {
        own: (await MemoRepository.update(pool, wsA, own, { title: "own renamed" }))?.title,
        foreignWithFields: await MemoRepository.update(pool, wsA, foreign, { title: "hijacked" }),
        foreignWithoutFields: await MemoRepository.update(pool, wsA, foreign, {}),
      }

      expect({ results, foreign: await memoRows([foreign]) }).toEqual({
        results: { own: "own renamed", foreignWithFields: null, foreignWithoutFields: null },
        foreign: before,
      })
    })

    test("should leave a foreign memo's search config unset when fillMissingSearchConfigs is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, {
        message: await addMessage(wsA, await addStream(wsA)),
        searchConfig: null,
      })
      const foreign = await addMemo(wsB, {
        message: await addMessage(wsB, await addStream(wsB)),
        searchConfig: null,
      })

      const filled = await MemoRepository.fillMissingSearchConfigs(pool, wsA, [
        { id: own, searchConfig: "english" },
        { id: foreign, searchConfig: "english" },
      ])

      expect({ filled, configs: (await memoRows([own, foreign])).map((row) => row.search_config) }).toEqual({
        filled: 1,
        configs: ["english", null],
      })
    })

    test("should leave a foreign memo's embedding and timestamp unchanged when updateEmbedding is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, { message: await addMessage(wsA, await addStream(wsA)) })
      const foreign = await addMemo(wsB, { message: await addMessage(wsB, await addStream(wsB)) })
      const foreignBefore = (await memoRows([foreign]))[0]

      await MemoRepository.updateEmbedding(pool, wsA, own, vec(1))
      await MemoRepository.updateEmbedding(pool, wsA, foreign, vec(1))

      expect(await memoRows([own, foreign])).toEqual([
        expect.objectContaining({ id: own, has_embedding: true }),
        foreignBefore,
      ])
    })

    test("should leave a foreign memo active when archive is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, { message: await addMessage(wsA, await addStream(wsA)) })
      const foreign = await addMemo(wsB, { message: await addMessage(wsB, await addStream(wsB)) })
      const foreignBefore = (await memoRows([foreign]))[0]

      const results = {
        own: (await MemoRepository.archive(pool, wsA, own))?.status,
        foreign: await MemoRepository.archive(pool, wsA, foreign),
      }

      expect({ results, foreign: (await memoRows([foreign]))[0] }).toEqual({
        results: { own: "archived", foreign: null },
        foreign: foreignBefore,
      })
    })

    test("should leave a foreign memo archived when unarchive is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, { message: await addMessage(wsA, await addStream(wsA)), status: "archived" })
      const foreign = await addMemo(wsB, {
        message: await addMessage(wsB, await addStream(wsB)),
        status: "archived",
      })
      const foreignBefore = (await memoRows([foreign]))[0]

      const results = {
        own: (await MemoRepository.unarchive(pool, wsA, own))?.status,
        foreign: await MemoRepository.unarchive(pool, wsA, foreign),
      }

      expect({ results, foreign: (await memoRows([foreign]))[0] }).toEqual({
        results: { own: "active", foreign: null },
        foreign: foreignBefore,
      })
    })

    test("should keep a foreign memo when delete is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const own = await addMemo(wsA, { message: await addMessage(wsA, await addStream(wsA)) })
      const foreign = await addMemo(wsB, { message: await addMessage(wsB, await addStream(wsB)) })

      const deleted = {
        own: await MemoRepository.delete(pool, wsA, own),
        foreign: await MemoRepository.delete(pool, wsA, foreign),
      }

      expect({ deleted, remaining: (await memoRows([own, foreign])).map((row) => row?.id) }).toEqual({
        deleted: { own: true, foreign: false },
        remaining: [undefined, foreign],
      })
    })
  })

  describe("pending items", () => {
    test("should return only the workspace's unprocessed items when findUnprocessed meets foreign items on the same stream", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const first = await addPending(wsA, stream, { queuedAt: new Date("2000-01-01T00:00:00Z") })
      const second = await addPending(wsA, stream, { queuedAt: new Date("2000-01-02T00:00:00Z") })
      await addPending(wsB, stream, { queuedAt: new Date("2000-01-01T12:00:00Z") })

      const found = await withClient(pool, (client) => PendingItemRepository.findUnprocessed(client, wsA, stream))

      expect(found.map((item) => item.id)).toEqual([first, second])
    })

    test("should count only the workspace's unprocessed items when countUnprocessed meets foreign items", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const otherStream = await addStream(wsA)
      await addPending(wsA, stream)
      await addPending(wsA, stream)
      await addPending(wsA, otherStream)
      await addPending(wsB, stream)
      await addPending(wsB, otherStream)

      const counts = await withClient(pool, async (client) => ({
        stream: await PendingItemRepository.countUnprocessed(client, wsA, stream),
        workspace: await PendingItemRepository.countUnprocessed(client, wsA),
      }))

      expect(counts).toEqual({ stream: 2, workspace: 3 })
    })

    test("should leave a foreign item unprocessed when markProcessed is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const own = await addPending(wsA, stream)
      const foreign = await addPending(wsB, stream)

      await withClient(pool, (client) =>
        PendingItemRepository.markProcessed(client, wsA, [
          { id: own, version: 0 },
          { id: foreign, version: 0 },
        ])
      )

      expect(await pendingRows([own, foreign])).toEqual([
        { id: own, workspace_id: wsA, processed: true, classified_fingerprint: null },
        { id: foreign, workspace_id: wsB, processed: false, classified_fingerprint: null },
      ])
    })

    test("should leave a foreign item's fingerprint unset when recordClassifiedFingerprints is given its id", async () => {
      const { wsA, wsB } = await seedPair()
      const stream = await addStream(wsA)
      const own = await addPending(wsA, stream)
      const foreign = await addPending(wsB, stream)

      await withClient(pool, (client) =>
        PendingItemRepository.recordClassifiedFingerprints(client, wsA, [
          { id: own, fingerprint: "fp-own" },
          { id: foreign, fingerprint: "fp-foreign" },
        ])
      )

      expect(await pendingRows([own, foreign])).toEqual([
        { id: own, workspace_id: wsA, processed: false, classified_fingerprint: "fp-own" },
        { id: foreign, workspace_id: wsB, processed: false, classified_fingerprint: null },
      ])
    })
  })
})
