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
import { plan, processChunk } from "../../src/features/stream-context/backfill"
import { workspaceId } from "../../src/lib/id"
import { sql } from "../../src/db"
import { StreamTypes, Visibilities } from "@threa/types"

describe("stream-context backfill against the real schema", () => {
  let pool: Pool
  let ctx: { pool: Pool }

  const wsId = workspaceId()
  let ownerId: string
  let peerId: string
  let channelId: string
  let dmId: string

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

  test("every chunk kind executes and the message chunks rebuild the rows", async () => {
    const chunks = await plan(ctx as never, wsId)
    for (const chunk of chunks) {
      await processChunk(ctx as never, wsId, chunk)
    }

    const rows = await pool.query<{ stream_id: string; category: string; ref_id: string }>(sql`
      SELECT stream_id, category, ref_id FROM stream_context_items WHERE workspace_id = ${wsId}
      ORDER BY ref_id
    `)

    expect(rows.rows).toEqual([
      { stream_id: channelId, category: "link", ref_id: `https://example.com/${channelId}/doc` },
      { stream_id: dmId, category: "link", ref_id: `https://example.com/${dmId}/doc` },
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
