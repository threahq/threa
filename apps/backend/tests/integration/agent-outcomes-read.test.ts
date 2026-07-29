/**
 * Cross-stream agent-outcomes read, against a real schema.
 *
 * The statement unions two tables, joins `stream_events` on a payload key, and
 * keysets on a computed `occurs_at` that is a different column per branch. None
 * of that survives a fake Querier, and an assertion on the query's TEXT cannot
 * tell a column that exists from one that does not (INV-68). These seed rows,
 * run the statement, and assert on what comes back.
 *
 * The access case that matters is INV-62: a follow-up inside a thread of a
 * public channel the viewer never joined must be returned — membership is not
 * access.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamEventRepository } from "../../src/features/streams"
import { EventService } from "../../src/features/messaging"
import { createAgentOutcomeService } from "../../src/features/agent-outcomes"
import { agentFollowUpId, delegationId, eventId, userId, workspaceId } from "../../src/lib/id"
import { sql, type Querier } from "../../src/db"
import { AuthorTypes, StreamTypes, Visibilities, type DelegationStatus, type FollowUpStatus } from "@threa/types"

let pool: Pool

beforeAll(async () => {
  pool = await setupTestDatabase()
})

afterAll(async () => {
  await pool.end()
})

async function seedFollowUp(
  db: Querier,
  params: { workspaceId: string; streamId: string; note: string; scheduledFor: Date; status: FollowUpStatus }
): Promise<string> {
  const id = agentFollowUpId()
  await db.query(sql`
    INSERT INTO agent_follow_ups (
      id, workspace_id, stream_id, persona_id, session_id, source_conversation_id,
      note, scheduled_for, status
    ) VALUES (
      ${id}, ${params.workspaceId}, ${params.streamId}, ${"persona_1"}, ${"sess_1"}, ${null},
      ${params.note}, ${params.scheduledFor}, ${params.status}
    )
  `)
  return id
}

async function seedDelegation(
  db: Querier,
  params: {
    workspaceId: string
    streamId: string
    title: string
    status: DelegationStatus
    statusChangedAt: Date
  }
): Promise<string> {
  const id = delegationId()
  await db.query(sql`
    INSERT INTO delegated_tasks (
      id, workspace_id, stream_id, session_id, source_conversation_id,
      created_by_kind, created_by_id, title, brief, context_refs, status, status_changed_at
    ) VALUES (
      ${id}, ${params.workspaceId}, ${params.streamId}, ${null}, ${null},
      ${AuthorTypes.PERSONA}, ${"persona_1"}, ${params.title}, ${"brief"}, ${"[]"}::jsonb,
      ${params.status}, ${params.statusChangedAt}
    )
  `)
  return id
}

describe("agent outcomes read path", () => {
  const wsId = workspaceId()
  const memberId = userId()
  const outsiderId = userId()
  const service = () => createAgentOutcomeService({ pool })

  let channelId: string
  let threadId: string
  let privateStreamId: string
  let threadFollowUpId: string
  let privateDelegationId: string
  let channelFollowUpId: string
  let channelDelegationId: string

  beforeAll(async () => {
    const streamService = new StreamService(pool)
    const eventService = new EventService(pool)

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Outcomes WS",
        slug: `outcomes-ws-${wsId}`,
        createdBy: memberId,
      })
      await addTestMember(client, wsId, memberId)
      await addTestMember(client, wsId, outsiderId)
    })

    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "outcomes-channel",
      slug: `outcomes-channel-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: memberId,
    })
    channelId = channel.id

    // Created by the outsider, so the viewer holds no membership row on it —
    // the case a `stream_members` filter would silently drop.
    const anchor = await eventService.createMessage({
      workspaceId: wsId,
      streamId: channelId,
      authorId: memberId,
      authorType: "user",
      ...testMessageContent("anchor"),
    })
    const thread = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.THREAD,
      parentStreamId: channelId,
      parentAnchorId: anchor.id,
      createdBy: outsiderId,
    })
    threadId = thread.id

    const privateStream = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "outcomes-private",
      slug: `outcomes-private-${wsId.slice(-8)}`,
      visibility: Visibilities.PRIVATE,
      createdBy: outsiderId,
    })
    privateStreamId = privateStream.id

    threadFollowUpId = await seedFollowUp(pool, {
      workspaceId: wsId,
      streamId: threadId,
      note: "Check the thread deploy",
      scheduledFor: new Date("2126-01-02T00:00:00.000Z"),
      status: "pending",
    })
    channelFollowUpId = await seedFollowUp(pool, {
      workspaceId: wsId,
      streamId: channelId,
      note: "Old follow-up",
      scheduledFor: new Date("2026-01-01T00:00:00.000Z"),
      status: "fired",
    })
    channelDelegationId = await seedDelegation(pool, {
      workspaceId: wsId,
      streamId: channelId,
      title: "Ship the migration",
      status: "running",
      statusChangedAt: new Date("2126-01-01T00:00:00.000Z"),
    })
    await withTransaction(pool, async (client) => {
      await StreamEventRepository.insert(client, {
        id: eventId(),
        streamId: threadId,
        eventType: "agent:follow_up_scheduled",
        payload: { followUpId: threadFollowUpId, note: "Check the thread deploy" },
        actorId: "persona_1",
        actorType: AuthorTypes.PERSONA,
      })
    })

    privateDelegationId = await seedDelegation(pool, {
      workspaceId: wsId,
      streamId: privateStreamId,
      title: "Secret task",
      status: "open",
      statusChangedAt: new Date("2126-01-03T00:00:00.000Z"),
    })
  })

  test("returns a follow-up inside a thread of a public channel the viewer never joined (INV-62)", async () => {
    const response = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })

    expect(response.items.map((i) => i.id)).toContain(threadFollowUpId)
  })

  test("omits a delegation in a private stream the viewer cannot read", async () => {
    const response = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })

    expect(response.items.map((i) => i.id)).not.toContain(privateDelegationId)
  })

  test("occursAt interleaves a future-dated pending follow-up above a just-updated delegation", async () => {
    const response = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })

    const ranked = response.items.map((i) => i.id)
    expect(ranked.indexOf(threadFollowUpId)).toBeLessThan(ranked.indexOf(channelDelegationId))
    expect(response.items.find((i) => i.id === threadFollowUpId)).toMatchObject({
      kind: "follow_up",
      title: "Check the thread deploy",
      status: "pending",
      occursAt: "2126-01-02T00:00:00.000Z",
      scheduledFor: "2126-01-02T00:00:00.000Z",
    })
    expect(response.items.find((i) => i.id === channelDelegationId)).toMatchObject({
      kind: "delegation",
      status: "running",
      occursAt: "2126-01-01T00:00:00.000Z",
      scheduledFor: null,
    })
  })

  test("resolves the anchor event a follow-up row deep-links to", async () => {
    const response = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })

    const followUp = response.items.find((i) => i.id === threadFollowUpId)
    expect(followUp?.anchorEventId).toMatch(/^event_/)
    expect(response.items.find((i) => i.id === channelFollowUpId)?.anchorEventId).toBeNull()
  })

  test("the outstanding count is opt-in and first-page only", async () => {
    const withoutCount = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })
    const withCount = await service().list({
      workspaceId: wsId,
      userId: memberId,
      state: "all",
      limit: 50,
      withCount: true,
    })

    expect({ off: withoutCount.outstandingCount, on: withCount.outstandingCount }).toEqual({ off: null, on: 2 })
  })

  test("scope=stream drops a thread's follow-up that scope=tree includes", async () => {
    const tree = await service().list({
      workspaceId: wsId,
      userId: memberId,
      state: "all",
      streamIds: [channelId],
      limit: 50,
    })
    const exact = await service().list({
      workspaceId: wsId,
      userId: memberId,
      state: "all",
      streamIds: [channelId],
      scope: "stream",
      limit: 50,
    })

    expect({
      treeHasThreadRow: tree.items.some((i) => i.id === threadFollowUpId),
      streamHasThreadRow: exact.items.some((i) => i.id === threadFollowUpId),
      streamIds: exact.items.map((i) => i.id).sort(),
    }).toEqual({
      treeHasThreadRow: true,
      streamHasThreadRow: false,
      streamIds: [channelDelegationId, channelFollowUpId].sort(),
    })
  })

  test("state=outstanding excludes every terminal status of both kinds", async () => {
    const outstanding = await service().list({ workspaceId: wsId, userId: memberId, state: "outstanding", limit: 50 })
    const settled = await service().list({ workspaceId: wsId, userId: memberId, state: "settled", limit: 50 })

    expect(outstanding.items.map((i) => i.id).sort()).toEqual([threadFollowUpId, channelDelegationId].sort())
    expect(settled.items.map((i) => i.id)).toEqual([channelFollowUpId])
  })

  test("streams=<root> includes rows that live in that stream's threads", async () => {
    const response = await service().list({
      workspaceId: wsId,
      userId: memberId,
      state: "all",
      streamIds: [channelId],
      limit: 50,
    })

    expect(response.items.map((i) => i.id).sort()).toEqual(
      [threadFollowUpId, channelDelegationId, channelFollowUpId].sort()
    )
  })

  test("kind and free-text filters narrow the same page", async () => {
    const followUpsOnly = await service().list({
      workspaceId: wsId,
      userId: memberId,
      state: "all",
      kind: "follow_up",
      limit: 50,
    })
    const searched = await service().list({
      workspaceId: wsId,
      userId: memberId,
      state: "all",
      queryText: "migration",
      limit: 50,
    })

    expect(followUpsOnly.items.map((i) => i.kind)).toEqual(["follow_up", "follow_up"])
    expect(searched.items.map((i) => i.id)).toEqual([channelDelegationId])
  })
})

/**
 * Paging across rows that share one instant. Every keyset timestamp here comes
 * from the database's own `NOW()` inside a single statement, so all five rows
 * carry the same microsecond-bearing `status_changed_at` — exactly what the
 * expiry sweep produces. Hand-written `.000Z` literals would put microseconds at
 * zero and the test could not fail, which is the INV-66 trap this replaces.
 */
describe("agent outcomes keyset paging over a shared instant", () => {
  const wsId = workspaceId()
  const memberId = userId()
  const service = () => createAgentOutcomeService({ pool })

  let seededIds: string[]

  beforeAll(async () => {
    const streamService = new StreamService(pool)

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Paging WS",
        slug: `paging-ws-${wsId}`,
        createdBy: memberId,
      })
      await addTestMember(client, wsId, memberId)
    })

    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "paging-channel",
      slug: `paging-channel-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: memberId,
    })

    seededIds = Array.from({ length: 5 }, () => delegationId())
    await pool.query(sql`
      INSERT INTO delegated_tasks (
        id, workspace_id, stream_id, created_by_kind, created_by_id, title, brief, status, status_changed_at
      )
      SELECT id, ${wsId}, ${channel.id}, ${AuthorTypes.PERSONA}, ${"persona_1"}, 'Shared instant', 'brief', 'open', NOW()
      FROM unnest(${seededIds}::text[]) AS id
    `)
  })

  test("every row is reachable across pages when they share a microsecond", async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const response = await service().list({
        workspaceId: wsId,
        userId: memberId,
        state: "all",
        limit: 2,
        cursor,
      })
      seen.push(...response.items.map((i) => i.id))
      if (!response.nextCursor) break
      cursor = response.nextCursor
    }

    expect(seen.slice().sort()).toEqual(seededIds.slice().sort())
  })
})
