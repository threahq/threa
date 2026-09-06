/**
 * The backfill's SQL, against a real schema.
 *
 * Its unit suite drives a fake pool, which cannot catch a column that does not
 * exist — the same gap that let `th.name` reach production in the read path. A
 * chunk that throws goes to the DLQ, and the symptom is an empty panel for all
 * historical content while live writes keep working.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { MemoRepository } from "../../src/features/memos"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { plan, processChunk } from "../../src/features/stream-context/backfill"
import { memoId, userEncryptionKeyId, workspaceId } from "../../src/lib/id"
import { sql } from "../../src/db"
import { StreamTypes, Visibilities } from "@threahq/types"

describe("stream-context backfill against the real schema", () => {
  let pool: Pool
  let ctx: { pool: Pool }

  const wsId = workspaceId()
  let ownerId: string
  let peerId: string
  let channelId: string
  let dmId: string
  let sealedStreamId: string
  let threadId: string
  let memoRefId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ctx = { pool }
    const streamService = new StreamService(pool)
    const eventService = new EventService(pool)

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Backfill WS",
        slug: `backfill-ws-${wsId}`,
        createdBy: wsId,
      })
      ownerId = (await addTestMember(client, wsId, `owner-${wsId.slice(-8)}`)).id
      peerId = (await addTestMember(client, wsId, `peer-${wsId.slice(-8)}`)).id
    })

    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "backfill-channel",
      slug: `backfill-channel-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: ownerId,
    })
    channelId = channel.id

    const dm = await streamService.findOrCreateDm({
      workspaceId: wsId,
      userOneId: ownerId,
      userTwoId: peerId,
    })
    dmId = dm.id

    for (const streamId of [channelId, dmId]) {
      await eventService.createMessage({
        workspaceId: wsId,
        streamId,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent(`see https://example.com/${streamId}/doc`),
      })
    }

    const anchor = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: ownerId,
      authorType: "user",
      ...testMessageContent("anchor for the thread"),
    })
    const thread = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.THREAD,
      parentStreamId: channelId,
      parentAnchorId: anchor.id,
      createdBy: ownerId,
    })
    threadId = thread.id
    const threadMessage = await eventService.createMessage({
      workspaceId: wsId,
      streamId: threadId,
      authorId: ownerId,
      authorType: "user",
      ...testMessageContent("we decided in the thread"),
    })
    memoRefId = memoId()
    await withTransaction(pool, async (client) => {
      await MemoRepository.insert(client, {
        id: memoRefId,
        workspaceId: wsId,
        memoType: "message",
        sourceMessageId: threadMessage.id,
        title: "Thread decision",
        abstract: "Settled in the thread",
        sourceMessageIds: [threadMessage.id],
        participantIds: [ownerId],
        knowledgeType: "decision",
      })
    })

    const sealed = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.SCRATCHPAD,
      name: "sealed-pad",
      visibility: Visibilities.PRIVATE,
      createdBy: ownerId,
    })
    sealedStreamId = sealed.id
    // Indexable content FIRST, then the seal: without it the stream would earn
    // a chunk, so the exclusion is what keeps it out rather than emptiness.
    await eventService.createMessage({
      workspaceId: wsId,
      streamId: sealedStreamId,
      authorId: ownerId,
      authorType: "user",
      ...testMessageContent("secret https://example.com/sealed/doc"),
    })
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: sealedStreamId,
      workspaceId: wsId,
      ownerUserId: ownerId,
      ownerUserKeyId: userEncryptionKeyId(),
    })

    // The rows the live write path just created are what the backfill must
    // converge on, so clear them and let the backfill rebuild from stored state.
    await pool.query(sql`DELETE FROM stream_context_items WHERE workspace_id = ${wsId}`)
  })

  afterAll(async () => {
    await pool.end()
  })

  test("plan lists the workspace's streams without throwing", async () => {
    const chunks = await plan(ctx as never, wsId)
    const streamIds = new Set(chunks.filter((c) => c.kind === "messages").map((c) => c.streamId))

    expect({ hasChannel: streamIds.has(channelId), hasDm: streamIds.has(dmId) }).toEqual({
      hasChannel: true,
      hasDm: true,
    })
  })

  test("plan skips sealed streams, so nothing E2E can reach processChunk", async () => {
    const chunks = await plan(ctx as never, wsId)

    expect(chunks.map((chunk) => chunk.streamId)).not.toContain(sealedStreamId)
  })

  test("a thread's memo is planned against the top-level stream the write path indexes to", async () => {
    const chunks = await plan(ctx as never, wsId)

    expect(chunks.filter((chunk) => chunk.kind === "memos").map((chunk) => chunk.streamId)).toEqual([channelId])
  })

  test("every chunk kind executes and the message chunks rebuild the rows", async () => {
    const chunks = await plan(ctx as never, wsId)
    for (const chunk of chunks) {
      await processChunk(ctx as never, wsId, chunk)
    }

    const rows = await pool.query<{ stream_id: string; category: string; ref_id: string }>(sql`
      SELECT stream_id, category, ref_id FROM stream_context_items WHERE workspace_id = ${wsId}
      ORDER BY category, ref_id
    `)

    expect(rows.rows).toEqual([
      { stream_id: channelId, category: "link", ref_id: `https://example.com/${channelId}/doc` },
      { stream_id: dmId, category: "link", ref_id: `https://example.com/${dmId}/doc` },
      { stream_id: channelId, category: "memo", ref_id: memoRefId },
      { stream_id: channelId, category: "thread", ref_id: threadId },
    ])
  })

  test("re-running every chunk inserts nothing new", async () => {
    const before = await pool.query<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM stream_context_items WHERE workspace_id = ${wsId}
    `)
    for (const chunk of await plan(ctx as never, wsId)) {
      await processChunk(ctx as never, wsId, chunk)
    }
    const after = await pool.query<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM stream_context_items WHERE workspace_id = ${wsId}
    `)

    expect(after.rows[0]!.count).toEqual(before.rows[0]!.count)
  })
})
