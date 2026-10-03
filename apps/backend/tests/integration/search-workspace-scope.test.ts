import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase } from "./setup"
import { SearchRepository } from "../../src/features/search"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { conversationId, messageId, personaId, streamId, userId, workspaceId } from "../../src/lib/id"

const EMBEDDING_DIMENSIONS = 1536
const unitVector = (axis: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0))
const vectorLiteral = (axis: number) => `[${unitVector(axis).join(",")}]`

const randomLetters = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => String.fromCharCode(97 + (byte % 26))).join("")

describe("Search, conversation search and agent stream scope workspace scope (INV-8, INV-62)", () => {
  let pool: Pool

  let wsA: string
  let wsB: string
  let m1: string
  let m2: string
  let bMember: string
  let persona: string
  let sequence = 0
  let token: string

  let publicA: string
  let publicB: string
  let privateA: string

  let legit: string
  let decoyM: string
  let semLegit: string

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, {
      id,
      name: `Search scope ${label}`,
      slug: `search-scope-${label}-${id}`,
      createdBy: userId(),
    })
    return id
  }

  async function seedMember(wid: string) {
    return (await addTestMember(pool, wid, userId())).id
  }

  async function seedStream(
    wid: string,
    options: {
      type?: string
      visibility?: string
      root?: string
      createdBy?: string
    } = {}
  ) {
    const id = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, slug, visibility, parent_stream_id, root_stream_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7)`,
      [
        id,
        wid,
        options.type ?? StreamTypes.CHANNEL,
        options.type === StreamTypes.THREAD ? null : `search-scope-${id}`,
        options.visibility ?? Visibilities.PUBLIC,
        options.root ?? null,
        options.createdBy ?? m1,
      ]
    )
    return id
  }

  async function addMember(wid: string, stream: string, member: string) {
    await pool.query(`INSERT INTO stream_members (stream_id, member_id, workspace_id) VALUES ($1, $2, $3)`, [
      stream,
      member,
      wid,
    ])
  }

  async function addPersona(wid: string, stream: string, personaIdValue: string) {
    await pool.query(
      `INSERT INTO stream_persona_participants (stream_id, persona_id, workspace_id) VALUES ($1, $2, $3)`,
      [stream, personaIdValue, wid]
    )
  }

  async function addMessage(
    wid: string,
    stream: string,
    options: { text?: string; embeddingAxis?: number; createdAt?: Date } = {}
  ) {
    const id = messageId()
    sequence += 1
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, '{}', $7::vector, $8)`,
      [
        id,
        wid,
        stream,
        sequence,
        m1,
        options.text ?? "plain words",
        options.embeddingAxis === undefined ? null : vectorLiteral(options.embeddingAxis),
        options.createdAt ?? new Date(),
      ]
    )
    return id
  }

  async function addConversation(wid: string, stream: string, messageIds: string[]) {
    const id = conversationId()
    await pool.query(
      `INSERT INTO conversations (id, stream_id, workspace_id, message_ids, topic_summary, embedding)
       VALUES ($1, $2, $3, $4::text[], 'scope fixture', $5::vector)`,
      [id, stream, wid, messageIds, vectorLiteral(0)]
    )
    return id
  }

  const sorted = (ids: string[]) => [...ids].sort()
  const idsOf = (rows: Array<{ id: string }>) => sorted(rows.map((row) => row.id))

  beforeAll(async () => {
    pool = await setupTestDatabase()

    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    m1 = await seedMember(wsA)
    m2 = await seedMember(wsA)
    bMember = await seedMember(wsB)
    persona = personaId()
    token = `scopetoken${randomLetters()}`

    publicA = await seedStream(wsA)
    publicB = await seedStream(wsB, { createdBy: bMember })
    privateA = await seedStream(wsA, { visibility: Visibilities.PRIVATE })
    await addMember(wsA, privateA, m1)

    legit = await addMessage(wsA, publicA, { text: `${token} legit` })
    decoyM = await addMessage(wsB, publicA, { text: `${token} decoy under an A stream` })
    await addMessage(wsA, publicB, { text: `${token} decoy in a B stream` })
    semLegit = await addMessage(wsA, publicA, { embeddingAxis: 0 })
    await addMessage(wsB, publicA, { embeddingAxis: 0 })
    await addMessage(wsA, publicB, { embeddingAxis: 0 })
  }, 60_000)

  afterAll(async () => {
    await pool.end()
  })

  describe("message search legs", () => {
    test("should return only the workspace's message in the stream when full-text searching with a query", async () => {
      const results = await SearchRepository.fullTextSearch(pool, {
        workspaceId: wsA,
        query: token,
        streamIds: [publicA, publicB],
        filters: {},
        limit: 20,
        ranking: "improved",
      })

      expect(idsOf(results)).toEqual([legit])
    })

    test("should return only the workspace's message in the stream when full-text searching without a query", async () => {
      const results = await SearchRepository.fullTextSearch(pool, {
        workspaceId: wsA,
        query: "",
        phrases: [token],
        streamIds: [publicA, publicB],
        filters: {},
        limit: 20,
        ranking: "improved",
      })

      expect(idsOf(results)).toEqual([legit])
    })

    test("should return only the workspace's message in the stream when searching for an exact substring", async () => {
      const results = await SearchRepository.exactSearch(pool, {
        workspaceId: wsA,
        query: token,
        streamIds: [publicA, publicB],
        filters: {},
        limit: 20,
      })

      expect(idsOf(results)).toEqual([legit])
    })

    test("should return only the workspace's messages when fetching messages by id", async () => {
      const results = await SearchRepository.messagesByIds(pool, {
        workspaceId: wsA,
        ids: [legit, decoyM],
        streamIds: [publicA],
      })

      expect(idsOf(results)).toEqual([legit])
    })

    test("should keep both hybrid legs inside the workspace's messages and streams", async () => {
      const results = await SearchRepository.hybridSearch(pool, {
        workspaceId: wsA,
        query: token,
        embedding: unitVector(0),
        streamIds: [publicA, publicB],
        filters: {},
        limit: 20,
        ranking: "improved",
      })

      expect(idsOf(results)).toEqual(sorted([legit, semLegit]))
    })
  })

  describe("conversation search", () => {
    let aMsg: string
    let aMsgAt: Date
    let bMsg: string
    let bMsgForOwnConversation: string
    let bMsgForForeignConversation: string
    let convLegit: string
    let convBOnly: string

    beforeAll(async () => {
      aMsgAt = new Date("2026-01-01T10:00:00.000Z")
      aMsg = await addMessage(wsA, publicA, { createdAt: aMsgAt })
      bMsg = await addMessage(wsB, publicB, { createdAt: new Date("2026-01-02T10:00:00.000Z") })
      bMsgForOwnConversation = await addMessage(wsB, publicB)
      bMsgForForeignConversation = await addMessage(wsB, publicB)

      convLegit = await addConversation(wsA, publicA, [aMsg, bMsg])
      convBOnly = await addConversation(wsA, publicA, [bMsgForOwnConversation])
      await addConversation(wsA, publicB, [aMsg])
      await addConversation(wsB, publicB, [bMsg])
      await addConversation(wsB, publicA, [bMsgForForeignConversation])
    })

    test("should match only the workspace's conversation and count only its own messages when searching conversations", async () => {
      const results = await SearchRepository.conversationSearch(pool, {
        workspaceId: wsA,
        embedding: unitVector(0),
        streamIds: [publicA, publicB],
        filters: {},
        limit: 20,
        maxDistance: 1,
      })

      expect(
        results.map((row) => ({
          id: row.id,
          streamId: row.streamId,
          messageCount: row.messageCount,
          firstMessageId: row.firstMessageId,
          firstMessageAt: row.firstMessageAt,
          lastMessageAt: row.lastMessageAt,
        }))
      ).toEqual([
        {
          id: convLegit,
          streamId: publicA,
          messageCount: 1,
          firstMessageId: aMsg,
          firstMessageAt: aMsgAt,
          lastMessageAt: aMsgAt,
        },
      ])
    })

    test("should resolve each message to the workspace's conversation when looking up conversations for messages", async () => {
      const results = await SearchRepository.conversationsForMessages(pool, {
        workspaceId: wsA,
        messageIds: [aMsg, bMsgForOwnConversation, bMsgForForeignConversation],
        streamIds: [publicA],
      })

      expect(
        Object.fromEntries(
          [...results].map(([message, conversation]) => [
            message,
            { id: conversation.id, streamId: conversation.streamId, messageCount: conversation.messageCount },
          ])
        )
      ).toEqual({
        [aMsg]: { id: convLegit, streamId: publicA, messageCount: 1 },
        [bMsgForOwnConversation]: { id: convBOnly, streamId: publicA, messageCount: 0 },
      })
    })
  })

  describe("accessible stream resolution", () => {
    let streamQ: string
    let threadQ: string
    let streamP: string
    let threadP: string
    let streamR: string
    let streamS: string
    let threadPrivateA: string
    let dmLegit: string
    let dmThread: string
    let publicStreamsA: string[]

    beforeAll(async () => {
      streamQ = await seedStream(wsA)
      threadQ = await seedStream(wsA, { type: StreamTypes.THREAD, root: streamQ })
      streamP = await seedStream(wsA)
      threadP = await seedStream(wsA, { type: StreamTypes.THREAD, root: streamP })
      streamR = await seedStream(wsA)
      streamS = await seedStream(wsA)
      await addMember(wsA, streamQ, m1)
      await addMember(wsA, streamQ, m2)
      await addMember(wsA, streamP, m1)
      await addMember(wsB, streamP, m2)
      await addMember(wsA, streamR, m1)
      await addPersona(wsA, streamR, persona)
      await addMember(wsA, streamS, m1)
      await addPersona(wsB, streamS, persona)

      threadPrivateA = await seedStream(wsA, {
        type: StreamTypes.THREAD,
        root: privateA,
        visibility: Visibilities.PRIVATE,
      })
      await seedStream(wsB, {
        type: StreamTypes.THREAD,
        root: privateA,
        visibility: Visibilities.PRIVATE,
        createdBy: bMember,
      })

      dmLegit = await seedStream(wsA, { type: StreamTypes.DM, visibility: Visibilities.PRIVATE })
      await addMember(wsA, dmLegit, m1)
      await addMember(wsA, dmLegit, m2)
      dmThread = await seedStream(wsA, { type: StreamTypes.THREAD, root: dmLegit, visibility: Visibilities.PRIVATE })
      const dmDecoyMember = await seedStream(wsA, { type: StreamTypes.DM, visibility: Visibilities.PRIVATE })
      await addMember(wsA, dmDecoyMember, m1)
      await addMember(wsB, dmDecoyMember, m2)
      const dmDecoyRoot = await seedStream(wsA, { type: StreamTypes.DM, visibility: Visibilities.PRIVATE })
      await addMember(wsA, dmDecoyRoot, m1)
      await addMember(wsB, dmDecoyRoot, m2)
      await seedStream(wsA, {
        type: StreamTypes.THREAD,
        root: dmDecoyRoot,
        visibility: Visibilities.PRIVATE,
      })
      await seedStream(wsA, {
        type: StreamTypes.THREAD,
        root: publicB,
        visibility: Visibilities.PRIVATE,
      })

      publicStreamsA = [publicA, streamQ, threadQ, streamP, threadP, streamR, streamS]
    })

    test("should count a participant only through the workspace's stream_members rows when filtering by users", async () => {
      const streams = await SearchRepository.getAccessibleStreamsWithMembers(pool, {
        workspaceId: wsA,
        userId: m1,
        userIds: [m1, m2],
      })

      expect(sorted(streams)).toEqual(sorted([streamQ, threadQ, dmLegit, dmThread]))
    })

    test("should count a persona only through the workspace's participant rows when filtering by users", async () => {
      const streams = await SearchRepository.getAccessibleStreamsWithMembers(pool, {
        workspaceId: wsA,
        userId: m1,
        userIds: [m1, persona],
      })

      expect(streams).toEqual([streamR])
    })

    test("should treat only a stream whose root is a public stream in the workspace as public", async () => {
      const streams = await SearchRepository.getPublicStreams(pool, wsA)

      expect(sorted(streams)).toEqual(sorted(publicStreamsA))
    })

    test("should expand a stream to the workspace's own threads when the agent may see the stream", async () => {
      const streams = await SearchRepository.getAccessibleStreamsForAgent(
        pool,
        { type: "public_plus_stream", streamId: privateA },
        wsA
      )

      expect(sorted(streams)).toEqual(sorted([...publicStreamsA, privateA, threadPrivateA]))
    })

    test("should intersect two users' access through the workspace's rows only when resolving a DM agent scope", async () => {
      const streams = await SearchRepository.getAccessibleStreamsForAgent(
        pool,
        { type: "user_intersection", userIds: [m1, m2] },
        wsA
      )

      expect(sorted(streams)).toEqual(sorted([...publicStreamsA, dmLegit, dmThread]))
    })
  })
})
