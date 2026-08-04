/**
 * The `follow_up` arm of the "In this stream" index, against a real schema.
 *
 * The row's status and scheduled time are NOT stored on the projection — they
 * are joined live from `agent_follow_ups` — and its deep link comes from a
 * payload-key join on `stream_events`. A fake Querier cannot tell either join
 * from a column that does not exist (INV-68), and the failure it would hide is
 * the one this whole arm exists to avoid: a cancelled follow-up still reading
 * `pending` in the panel.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { AgentFollowUpService } from "../../src/features/agents"
import { createStreamContextService, StreamContextRepository } from "../../src/features/stream-context"
import { plan, processChunk } from "../../src/features/stream-context/backfill"
import { DelegationService } from "../../src/features/delegations"
import { streamContextItemId, workspaceId } from "../../src/lib/id"
import { sql } from "../../src/db"
import { AuthorTypes, StreamTypes, Visibilities, type StreamContextFollowUpDetail } from "@threa/types"

describe("follow-up context index against the real schema", () => {
  let pool: Pool
  let followUpService: AgentFollowUpService
  let contextService: ReturnType<typeof createStreamContextService>

  const wsId = workspaceId()
  // Relative, not a literal: a fixed instant goes stale the day it passes, and
  // then the firing worker fires this row before the cancel test reaches it —
  // `cancel` no-ops on a fired follow-up and the suite starts failing on a date.
  const scheduledFor = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  let ownerId: string
  let channelId: string
  let followUpId: string
  let delegationRefId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    followUpService = new AgentFollowUpService({
      pool,
      workspaceSettingsService: { getSettings: async () => ({ maxPendingFollowUps: 10 }) },
    })
    contextService = createStreamContextService({ pool })

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Follow-up WS",
        slug: `follow-up-ws-${wsId}`,
        createdBy: wsId,
      })
      ownerId = (await addTestMember(client, wsId, `owner-${wsId.slice(-8)}`)).id
    })

    const channel = await new StreamService(pool).create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "follow-up-channel",
      slug: `follow-up-channel-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: ownerId,
    })
    channelId = channel.id

    const scheduled = await followUpService.schedule({
      workspaceId: wsId,
      streamId: channelId,
      personaId: "persona_system_ariadne",
      sessionId: "session_1",
      sourceConversationId: null,
      note: "check back on the deploy",
      scheduledFor,
    })
    if (!scheduled.ok) throw new Error("follow-up schedule hit the cap")
    followUpId = scheduled.followUp.id

    const delegation = await new DelegationService({ pool }).create({
      workspaceId: wsId,
      streamId: channelId,
      sessionId: null,
      sourceConversationId: null,
      createdByKind: AuthorTypes.PERSONA,
      createdById: "persona_system_ariadne",
      title: "walk the release checklist",
      brief: "confirm every step is signed off",
      contextRefs: [],
    })
    delegationRefId = delegation.id

    // A third category, so `categories` has something to exclude.
    await StreamContextRepository.insertMany(pool, [
      {
        id: streamContextItemId(),
        workspaceId: wsId,
        streamId: channelId,
        rootStreamId: channelId,
        category: "link",
        refKind: "url",
        refId: "https://example.test/release",
        groupKey: "https://example.test/release",
        sourceMessageId: null,
        authorId: ownerId,
        occurredAt: new Date("2026-07-29T09:00:00.000Z"),
        sequence: null,
        snippet: "release notes",
        detail: { url: "https://example.test/release" },
      },
    ])
  })

  afterAll(async () => {
    await pool.end()
  })

  async function readFollowUpRow() {
    const response = await contextService.list({
      workspaceId: wsId,
      userId: ownerId,
      streamId: channelId,
      scope: "tree",
      limit: 20,
    })
    return response
  }

  test("scheduling projects one indexed row carrying the live pending status", async () => {
    const response = await readFollowUpRow()
    const item = response.items.find((row) => row.category === "follow_up")

    expect({
      refId: item?.refId,
      snippet: item?.snippet,
      detail: item?.detail as StreamContextFollowUpDetail,
      followUpCount: response.counts?.follow_up,
    }).toEqual({
      refId: followUpId,
      snippet: "check back on the deploy",
      detail: {
        note: "check back on the deploy",
        status: "pending",
        scheduledFor: scheduledFor.toISOString(),
      },
      followUpCount: 1,
    })
  })

  test("the row deep-links to its agent:follow_up_scheduled event", async () => {
    const response = await readFollowUpRow()
    const item = response.items.find((row) => row.category === "follow_up")
    const event = await pool.query<{ id: string }>(sql`
      SELECT id FROM stream_events
      WHERE stream_id = ${channelId}
        AND event_type = 'agent:follow_up_scheduled'
        AND payload->>'followUpId' = ${followUpId}
    `)

    expect(item?.anchorEventId).toBe(event.rows[0]!.id)
  })

  test("the free-text predicate reaches the joined note", async () => {
    const response = await contextService.list({
      workspaceId: wsId,
      userId: ownerId,
      streamId: channelId,
      scope: "tree",
      queryText: "the deploy",
      limit: 20,
    })

    expect(response.items.map((row) => row.refId)).toEqual([followUpId])
  })

  test("the categories filter returns both agent categories and nothing else", async () => {
    // Three categories have to be present for this to discriminate: with only
    // the follow-up in the stream the assertion holds even if `categories` is
    // ignored outright, or honours just its first element.
    const response = await contextService.list({
      workspaceId: wsId,
      userId: ownerId,
      streamId: channelId,
      scope: "tree",
      categories: ["follow_up", "delegation"],
      limit: 20,
    })

    expect({
      categories: [...new Set(response.items.map((row) => row.category))].sort(),
      refIds: response.items.map((row) => row.refId).sort(),
    }).toEqual({
      categories: ["delegation", "follow_up"],
      refIds: [delegationRefId, followUpId].sort(),
    })
  })

  test("cancelling flips the indexed row's status — the stored detail cannot show pending", async () => {
    const cancelled = await followUpService.cancel({ workspaceId: wsId, id: followUpId })
    expect(cancelled?.status).toBe("cancelled")

    const stored = await pool.query<{ detail: Record<string, unknown> }>(sql`
      SELECT detail FROM stream_context_items
      WHERE workspace_id = ${wsId} AND category = 'follow_up' AND ref_id = ${followUpId}
    `)
    const response = await readFollowUpRow()
    const item = response.items.find((row) => row.category === "follow_up")

    expect({
      storedDetail: stored.rows[0]?.detail,
      readStatus: (item?.detail as StreamContextFollowUpDetail).status,
    }).toEqual({
      storedDetail: { note: "check back on the deploy" },
      readStatus: "cancelled",
    })
  })

  test("the follow_ups backfill chunk is idempotent against the live row", async () => {
    const chunks = (await plan({ pool } as never, wsId)).filter((chunk) => chunk.kind === "follow_ups")
    expect(chunks).toEqual([{ kind: "follow_ups", streamId: channelId, rootStreamId: channelId }])

    const counts: number[] = []
    for (let run = 0; run < 2; run += 1) {
      for (const chunk of chunks) await processChunk({ pool } as never, wsId, chunk)
      const rows = await pool.query<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM stream_context_items
        WHERE workspace_id = ${wsId} AND category = 'follow_up'
      `)
      counts.push(Number(rows.rows[0]!.count))
    }

    expect(counts).toEqual([1, 1])
  })
})
