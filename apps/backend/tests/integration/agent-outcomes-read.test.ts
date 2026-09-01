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
import { agentFollowUpId, delegationId, eventId, subagentRunId, userId, workspaceId } from "../../src/lib/id"
import { sql, type Querier } from "../../src/db"
import {
  AuthorTypes,
  StreamTypes,
  Visibilities,
  type DelegationStatus,
  type FollowUpStatus,
  type SubagentStatus,
} from "@threa/types"

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
  let expiredDelegationId: string
  let threadFollowUpEventId: string

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
    const thread = await streamService.createThreadInternal({
      workspaceId: wsId,
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
    expiredDelegationId = await seedDelegation(pool, {
      workspaceId: wsId,
      streamId: channelId,
      title: "Recover the expired claim",
      status: "expired",
      statusChangedAt: new Date("2126-01-01T00:01:00.000Z"),
    })
    threadFollowUpEventId = eventId()
    await withTransaction(pool, async (client) => {
      await StreamEventRepository.insert(client, {
        id: threadFollowUpEventId,
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

  test("state=outstanding reads as an agenda — the running delegation leads, not trails", async () => {
    // The failure this pins: a delegation's occurs_at is its last transition
    // (past) and a follow-up's is when it fires (future), so newest-first buries
    // every running delegation behind every scheduled follow-up — off the first
    // page entirely once a workspace has a page's worth of them.
    const outstanding = await service().list({ workspaceId: wsId, userId: memberId, state: "outstanding", limit: 50 })
    const settled = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })

    const outstandingRanked = outstanding.items.map((i) => i.id)
    const settledRanked = settled.items.map((i) => i.id)

    expect({
      delegationBeforeFollowUp:
        outstandingRanked.indexOf(channelDelegationId) < outstandingRanked.indexOf(threadFollowUpId),
      allStillNewestFirst: settledRanked.indexOf(threadFollowUpId) < settledRanked.indexOf(channelDelegationId),
    }).toEqual({ delegationBeforeFollowUp: true, allStillNewestFirst: true })
  })

  test("resolves the anchor event a follow-up row deep-links to", async () => {
    const response = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })

    expect({
      threadAnchor: response.items.find((i) => i.id === threadFollowUpId)?.anchorEventId,
      channelAnchor: response.items.find((i) => i.id === channelFollowUpId)?.anchorEventId,
    }).toEqual({ threadAnchor: threadFollowUpEventId, channelAnchor: null })
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

    expect({ off: withoutCount.outstandingCount, on: withCount.outstandingCount }).toEqual({ off: null, on: 3 })
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
      streamIds: [channelDelegationId, expiredDelegationId, channelFollowUpId].sort(),
    })
  })

  test("state=outstanding excludes every terminal status of both kinds", async () => {
    const outstanding = await service().list({ workspaceId: wsId, userId: memberId, state: "outstanding", limit: 50 })
    const settled = await service().list({ workspaceId: wsId, userId: memberId, state: "settled", limit: 50 })

    expect(outstanding.items.map((i) => i.id).sort()).toEqual(
      [threadFollowUpId, channelDelegationId, expiredDelegationId].sort()
    )
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
      [threadFollowUpId, channelDelegationId, expiredDelegationId, channelFollowUpId].sort()
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

  async function pageThrough(state: "all" | "outstanding"): Promise<string[]> {
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const response = await service().list({ workspaceId: wsId, userId: memberId, state, limit: 2, cursor })
      seen.push(...response.items.map((i) => i.id))
      if (!response.nextCursor) break
      cursor = response.nextCursor
    }
    return seen
  }

  test("every row is reachable across pages when they share a microsecond", async () => {
    expect((await pageThrough("all")).sort()).toEqual(seededIds.slice().sort())
  })

  // Outstanding pages ascending, so its cursor predicate is the mirror image of
  // the descending one. A direction added without flipping the comparison walks
  // the same page forever or skips the rest of the set outright.
  test("the ascending keyset pages the same set exactly once", async () => {
    expect((await pageThrough("outstanding")).sort()).toEqual(seededIds.slice().sort())
  })
})

/**
 * The third UNION arm. It differs from the other two in a way a fake Querier
 * cannot show: a subagent scopes on `parent_stream_id` (the card's stream, not
 * the run's thread) and resolves its own anchor from the stored `card_event_id`
 * rather than the payload join the other arms use — so a column that does not
 * exist, or a join that quietly wins over it, only shows up against the schema
 * (INV-68). Its own workspace, so the suite above keeps its exact row sets.
 */
describe("agent outcomes subagent arm", () => {
  const wsId = workspaceId()
  const memberId = userId()
  const outsiderId = userId()
  const service = () => createAgentOutcomeService({ pool })

  let channelId: string
  let privateStreamId: string
  let activeRunId: string
  let completedRunId: string
  let privateRunId: string
  let activeCardEventId: string

  async function seedSubagentRun(params: {
    parentStreamId: string
    title: string
    status: SubagentStatus
    statusChangedAt: Date
    cardEventId: string
    statusNote?: string
  }): Promise<string> {
    const id = subagentRunId()
    await pool.query(sql`
      INSERT INTO subagent_runs (
        id, workspace_id, parent_stream_id, scope_stream_id, card_event_id, thread_stream_id,
        persona_id, model, created_by, title, brief, status, status_note, status_changed_at
      ) VALUES (
        ${id}, ${wsId}, ${params.parentStreamId}, ${params.parentStreamId}, ${params.cardEventId},
        ${`stream_thread_${id}`}, ${"persona_1"}, ${"openrouter:anthropic/claude-opus-5"}, ${memberId},
        ${params.title}, ${"brief"}, ${params.status}, ${params.statusNote ?? null}, ${params.statusChangedAt}
      )
    `)
    return id
  }

  beforeAll(async () => {
    const streamService = new StreamService(pool)

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Subagent outcomes WS",
        slug: `subagent-outcomes-ws-${wsId}`,
        createdBy: memberId,
      })
      await addTestMember(client, wsId, memberId)
      await addTestMember(client, wsId, outsiderId)
    })

    const channel = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "subagent-outcomes",
      slug: `subagent-outcomes-${wsId.slice(-8)}`,
      visibility: Visibilities.PUBLIC,
      createdBy: memberId,
    })
    channelId = channel.id

    const privateStream = await streamService.create({
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      name: "subagent-outcomes-private",
      slug: `subagent-outcomes-private-${wsId.slice(-8)}`,
      visibility: Visibilities.PRIVATE,
      createdBy: outsiderId,
    })
    privateStreamId = privateStream.id

    activeCardEventId = eventId()
    await withTransaction(pool, async (client) => {
      await StreamEventRepository.insert(client, {
        id: activeCardEventId,
        streamId: channelId,
        eventType: "subagent:created",
        payload: { subagentId: "subagent_placeholder", title: "Second opinion" },
        actorId: "persona_1",
        actorType: AuthorTypes.PERSONA,
      })
    })

    activeRunId = await seedSubagentRun({
      parentStreamId: channelId,
      title: "Second opinion on retry semantics",
      status: "active",
      statusChangedAt: new Date("2126-02-01T00:00:00.000Z"),
      cardEventId: activeCardEventId,
    })
    completedRunId = await seedSubagentRun({
      parentStreamId: channelId,
      title: "Reviewed the migration",
      status: "completed",
      statusChangedAt: new Date("2126-02-02T00:00:00.000Z"),
      cardEventId: eventId(),
    })
    privateRunId = await seedSubagentRun({
      parentStreamId: privateStreamId,
      title: "Secret second opinion",
      status: "active",
      statusChangedAt: new Date("2126-02-03T00:00:00.000Z"),
      cardEventId: eventId(),
    })
  })

  test("returns a run as its own kind, anchored on the card the row already stores", async () => {
    const response = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })

    expect(response.items.find((i) => i.id === activeRunId)).toMatchObject({
      kind: "subagent",
      title: "Second opinion on retry semantics",
      status: "active",
      occursAt: "2126-02-01T00:00:00.000Z",
      scheduledFor: null,
      actorType: "user",
      actorId: memberId,
      streamId: channelId,
      anchorEventId: activeCardEventId,
    })
  })

  test("omits a run whose parent stream the viewer cannot read", async () => {
    const response = await service().list({ workspaceId: wsId, userId: memberId, state: "all", limit: 50 })

    expect(response.items.map((i) => i.id)).not.toContain(privateRunId)
  })

  test("splits active from settled and narrows on kind", async () => {
    const outstanding = await service().list({ workspaceId: wsId, userId: memberId, state: "outstanding", limit: 50 })
    const settled = await service().list({ workspaceId: wsId, userId: memberId, state: "settled", limit: 50 })
    const subagentsOnly = await service().list({
      workspaceId: wsId,
      userId: memberId,
      state: "all",
      kind: "subagent",
      limit: 50,
    })

    expect({
      outstanding: outstanding.items.map((i) => i.id),
      settled: settled.items.map((i) => i.id),
      onlySubagents: subagentsOnly.items.map((i) => i.id).sort(),
    }).toEqual({
      outstanding: [activeRunId],
      settled: [completedRunId],
      onlySubagents: [activeRunId, completedRunId].sort(),
    })
  })

  test("a kind filter for another kind excludes runs entirely", async () => {
    const delegationsOnly = await service().list({
      workspaceId: wsId,
      userId: memberId,
      state: "all",
      kind: "delegation",
      limit: 50,
    })

    expect(delegationsOnly.items).toEqual([])
  })
})
