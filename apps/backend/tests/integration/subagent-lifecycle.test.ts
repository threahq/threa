/**
 * Subagent run lifecycle against the real schema (INV-68): open a run, close it,
 * lose the races, and settle the ones nobody came back to.
 *
 * The seams these pin are the ones a plausible refactor breaks silently: the
 * create is ONE transaction (card event + thread + row + kickoff job, or none of
 * them), the stream's single live slot is decided by the partial unique index
 * rather than a read-then-write (INV-20), and every status transition appends
 * its card patch in the same transaction as the CAS (INV-4/7) — so a losing
 * racer moves nothing and says so.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes, SubagentStatuses } from "@threa/types"
import { StreamEventRepository, StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { createReportBackTool } from "../../src/features/agents/tools"
import { SubagentAlreadyActiveError, SubagentService, createSubagentExpirySweep } from "../../src/features/subagents"
import { JobQueues, QueueRepository } from "../../src/lib/queue"
import { messageId } from "../../src/lib/id"
import { withTransaction } from "../../src/db"
import { setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { DELEGATED_MODEL, createParams, createSubagentTestContext, type SubagentTestContext } from "./subagent-support"

let pool: Pool
let cleanup: () => Promise<void>
let ctx: SubagentTestContext
let subagentService: SubagentService

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("subagent-lifecycle")
  pool = db.pool
  cleanup = db.cleanup
  ctx = await createSubagentTestContext(pool, "lifecycle")
  subagentService = new SubagentService({ pool, streamService: ctx.streamService })
})

afterAll(async () => {
  await cleanup()
})

async function cardEvents(streamId: string) {
  return StreamEventRepository.list(pool, streamId, { types: ["subagent:created"] })
}

async function statusEvents(streamId: string) {
  return StreamEventRepository.list(pool, streamId, { types: ["subagent:status_changed"] })
}

/** Claim from the queue the way the persona-agent worker does. */
async function claimKickoffJobs(streamId: string) {
  const now = new Date()
  const claimed = await QueueRepository.batchClaimMessages(pool, {
    queueName: JobQueues.PERSONA_AGENT,
    workspaceId: ctx.workspaceId,
    now,
    claimedAt: now,
    claimedBy: "test",
    claimedUntil: new Date(now.getTime() + 60_000),
    limit: 20,
  })
  return claimed.filter((job) => (job.payload as { streamId?: string }).streamId === streamId)
}

async function outboxEventTypes(streamId: string): Promise<string[]> {
  const result = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM outbox WHERE payload->>'streamId' = $1 AND event_type LIKE 'stream:subagent%' ORDER BY id`,
    [streamId]
  )
  return result.rows.map((row) => row.event_type)
}

describe("subagent create", () => {
  test("row, card event, thread and kickoff job land in one transaction", async () => {
    const channel = await ctx.createChannel({ slug: "create" })

    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    expect(await subagentService.getById({ workspaceId: ctx.workspaceId, id: run.id })).toMatchObject({
      id: run.id,
      workspaceId: ctx.workspaceId,
      parentStreamId: channel.id,
      threadStreamId,
      cardEventId: run.cardEventId,
      personaId: ctx.persona.id,
      model: DELEGATED_MODEL,
      createdBy: ctx.owner,
      title: "Second opinion on the migration plan",
      brief: "Review the plan and tell the user what it misses.",
      status: SubagentStatuses.ACTIVE,
      statusNote: null,
      resultMessageId: null,
    })

    const cards = await cardEvents(channel.id)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: run.cardEventId,
      eventType: "subagent:created",
      actorId: ctx.persona.id,
      actorType: AuthorTypes.PERSONA,
      payload: {
        subagentId: run.id,
        title: "Second opinion on the migration plan",
        model: DELEGATED_MODEL,
        personaId: ctx.persona.id,
        threadStreamId,
        createdBy: ctx.owner,
        sourceConversationId: null,
      },
    })
    // The card takes a dense broadcast slot, so a missing number downstream is a
    // real timeline gap (INV-61).
    expect(cards[0].broadcastSequence).not.toBeNull()

    const thread = await StreamRepository.findById(pool, threadStreamId)
    expect(thread).toMatchObject({
      id: threadStreamId,
      workspaceId: ctx.workspaceId,
      type: "thread",
      parentStreamId: channel.id,
      parentAnchorId: run.cardEventId,
      rootStreamId: channel.id,
      visibility: channel.visibility,
      createdBy: ctx.owner,
    })

    expect(await outboxEventTypes(channel.id)).toEqual(["stream:subagent_created"])

    const jobs = await claimKickoffJobs(threadStreamId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].payload).toEqual({
      workspaceId: ctx.workspaceId,
      streamId: threadStreamId,
      messageId: `subagent_${run.id}`,
      personaId: ctx.persona.id,
      triggeredBy: ctx.owner,
      subagentRunId: run.id,
    })
  })

  test("a second concurrent create loses the unique-index race and leaves nothing behind", async () => {
    const channel = await ctx.createChannel({ slug: "race" })

    const results = await Promise.allSettled([
      subagentService.create(createParams(ctx, channel.id, { title: "First" })),
      subagentService.create(createParams(ctx, channel.id, { title: "Second" })),
    ])

    const fulfilled = results.filter((result) => result.status === "fulfilled")
    const rejected = results.filter((result) => result.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SubagentAlreadyActiveError)

    // The loser rolled back whole: one card, one thread, one kickoff job.
    const cards = await cardEvents(channel.id)
    expect(cards).toHaveLength(1)
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<SubagentService["create"]>>>).value
    expect(cards[0].id).toBe(winner.run.cardEventId)
    expect(await claimKickoffJobs(winner.threadStreamId)).toHaveLength(1)

    const threads = await pool.query<{ id: string }>(`SELECT id FROM streams WHERE parent_stream_id = $1`, [channel.id])
    expect(threads.rows.map((row) => row.id)).toEqual([winner.threadStreamId])
  })

  test("a sequential second create in the same stream is refused with the typed error", async () => {
    const channel = await ctx.createChannel({ slug: "sequential" })
    await subagentService.create(createParams(ctx, channel.id))

    await expect(subagentService.create(createParams(ctx, channel.id))).rejects.toBeInstanceOf(
      SubagentAlreadyActiveError
    )
  })
})

describe("report_back", () => {
  test("completes the run, links the result message, and patches the card once", async () => {
    const channel = await ctx.createChannel({ slug: "report-back" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))
    const resultMessageId = messageId()

    const completed = await subagentService.reportBack({
      workspaceId: ctx.workspaceId,
      id: run.id,
      resultMessageId,
    })

    expect(completed).toMatchObject({
      id: run.id,
      status: SubagentStatuses.COMPLETED,
      resultMessageId,
      statusNote: null,
    })
    expect(await subagentService.findActiveByThreadStream({ workspaceId: ctx.workspaceId, threadStreamId })).toBeNull()

    const patches = await statusEvents(channel.id)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      eventType: "subagent:status_changed",
      actorId: ctx.persona.id,
      actorType: AuthorTypes.PERSONA,
      payload: { subagentId: run.id, status: SubagentStatuses.COMPLETED, resultMessageId, statusNote: null },
    })
    expect((patches[0].payload as { lastAgentMessageAt: string | null }).lastAgentMessageAt).not.toBeNull()
    // A patch is not a broadcast row — it advances the card that already holds a slot.
    expect(patches[0].broadcastSequence).toBeNull()
    expect(await outboxEventTypes(channel.id)).toEqual(["stream:subagent_created", "stream:subagent_status_changed"])
  })

  test("the tool posts its summary in the thread and closes the run against that message", async () => {
    const channel = await ctx.createChannel({ slug: "report-back-tool" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    // The turn's own message path, then the CAS — the order the tool relies on
    // so the card's "done" and the answer it points at cannot disagree.
    const tool = createReportBackTool({
      reportBack: async ({ summary }) => {
        const posted = messageId()
        await withTransaction(pool, (client) =>
          MessageRepository.insert(client, {
            id: posted,
            streamId: threadStreamId,
            sequence: 1n,
            authorId: ctx.persona.id,
            authorType: AuthorTypes.PERSONA,
            ...testMessageContent(summary),
          })
        )
        const completed = await subagentService.reportBack({
          workspaceId: ctx.workspaceId,
          id: run.id,
          resultMessageId: posted,
        })
        return completed ? { ok: true, subagentId: completed.id } : { ok: false, reason: "already_closed" }
      },
    })

    const result = await tool.config.execute({ summary: "The plan misses the backfill window." }, { toolCallId: "c1" })

    expect(JSON.parse(result.output)).toMatchObject({ ok: true, subagentId: run.id })
    const settled = await subagentService.getById({ workspaceId: ctx.workspaceId, id: run.id })
    expect(settled).toMatchObject({ status: SubagentStatuses.COMPLETED })
    expect(await MessageRepository.findById(pool, settled!.resultMessageId!)).toMatchObject({
      streamId: threadStreamId,
      contentMarkdown: "The plan misses the backfill window.",
    })
  })

  test("a replayed report_back CASes nothing and appends no second patch", async () => {
    const channel = await ctx.createChannel({ slug: "report-back-replay" })
    const { run } = await subagentService.create(createParams(ctx, channel.id))
    const first = messageId()

    await subagentService.reportBack({ workspaceId: ctx.workspaceId, id: run.id, resultMessageId: first })
    const replay = await subagentService.reportBack({
      workspaceId: ctx.workspaceId,
      id: run.id,
      resultMessageId: messageId(),
    })

    expect(replay).toBeNull()
    expect(await subagentService.getById({ workspaceId: ctx.workspaceId, id: run.id })).toMatchObject({
      status: SubagentStatuses.COMPLETED,
      resultMessageId: first,
    })
    expect(await statusEvents(channel.id)).toHaveLength(1)
  })

  test("report_back after a cancel reports the run already closed", async () => {
    const channel = await ctx.createChannel({ slug: "cancel-then-report" })
    const { run } = await subagentService.create(createParams(ctx, channel.id))

    const cancelled = await subagentService.cancel({
      workspaceId: ctx.workspaceId,
      id: run.id,
      parentStreamId: channel.id,
      cancelledBy: { actorId: ctx.owner, actorType: AuthorTypes.USER },
    })
    expect(cancelled).toMatchObject({ status: SubagentStatuses.CANCELLED })

    expect(
      await subagentService.reportBack({
        workspaceId: ctx.workspaceId,
        id: run.id,
        resultMessageId: messageId(),
      })
    ).toBeNull()
    expect(await statusEvents(channel.id)).toHaveLength(1)
  })
})

describe("failure, expiry and requeue", () => {
  test("a dead runtime fails the run by thread id and patches the card", async () => {
    const channel = await ctx.createChannel({ slug: "session-failure" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    const failed = await failRun(threadStreamId, "The delegated model's session was orphaned (stale heartbeat).")

    expect(failed).toMatchObject({
      id: run.id,
      status: SubagentStatuses.FAILED,
      statusNote: "The delegated model's session was orphaned (stale heartbeat).",
    })
    const patches = await statusEvents(channel.id)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      actorType: AuthorTypes.SYSTEM,
      payload: {
        subagentId: run.id,
        status: SubagentStatuses.FAILED,
        statusNote: "The delegated model's session was orphaned (stale heartbeat).",
      },
    })

    // Failing a thread with no live run is a no-op, not an error — every other
    // stream's session failures route through the same call.
    expect(await failRun(threadStreamId, "second failure")).toBeNull()
  })

  test("requeue reactivates a failed run, re-enqueues the kickoff, and loses the slot race", async () => {
    const channel = await ctx.createChannel({ slug: "requeue" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))
    await claimKickoffJobs(threadStreamId)
    await failRun(threadStreamId, "died")

    const reactivated = await subagentService.requeue({
      workspaceId: ctx.workspaceId,
      id: run.id,
      parentStreamId: channel.id,
      requeuedBy: { actorId: ctx.owner, actorType: AuthorTypes.USER },
    })

    expect(reactivated).toMatchObject({ id: run.id, status: SubagentStatuses.ACTIVE, statusNote: null })
    const requeuedJobs = await claimKickoffJobs(threadStreamId)
    expect(requeuedJobs).toHaveLength(1)
    expect(requeuedJobs[0].payload).toMatchObject({ subagentRunId: run.id, streamId: threadStreamId })
    expect(await statusEvents(channel.id)).toHaveLength(2)

    // Requeue of an already-active run matches no row: `active` is not requeueable.
    expect(
      await subagentService.requeue({
        workspaceId: ctx.workspaceId,
        id: run.id,
        parentStreamId: channel.id,
        requeuedBy: { actorId: ctx.owner, actorType: AuthorTypes.USER },
      })
    ).toBeNull()
  })

  test("requeue is refused while another subagent holds the stream's live slot", async () => {
    const channel = await ctx.createChannel({ slug: "requeue-race" })
    const first = await subagentService.create(createParams(ctx, channel.id, { title: "First" }))
    await failRun(first.threadStreamId, "died")
    const second = await subagentService.create(createParams(ctx, channel.id, { title: "Second" }))

    await expect(
      subagentService.requeue({
        workspaceId: ctx.workspaceId,
        id: first.run.id,
        parentStreamId: channel.id,
        requeuedBy: { actorId: ctx.owner, actorType: AuthorTypes.USER },
      })
    ).rejects.toBeInstanceOf(SubagentAlreadyActiveError)

    expect(await subagentService.getById({ workspaceId: ctx.workspaceId, id: first.run.id })).toMatchObject({
      status: SubagentStatuses.FAILED,
    })
    expect(
      await subagentService.findActiveByParentStream({ workspaceId: ctx.workspaceId, parentStreamId: channel.id })
    ).toMatchObject({ id: second.run.id })
  })

  test("the sweep expires runs idle past the threshold and leaves fresh ones alone", async () => {
    const idleChannel = await ctx.createChannel({ slug: "sweep-idle" })
    const freshChannel = await ctx.createChannel({ slug: "sweep-fresh" })
    const idle = await subagentService.create(createParams(ctx, idleChannel.id))
    const fresh = await subagentService.create(createParams(ctx, freshChannel.id))
    await pool.query(`UPDATE subagent_runs SET status_changed_at = NOW() - interval '8 days' WHERE id = $1`, [
      idle.run.id,
    ])

    const sweep = createSubagentExpirySweep(subagentService, { intervalMs: 3_600_000 })
    sweep.start()
    try {
      await waitFor(async () => {
        const row = await subagentService.getById({ workspaceId: ctx.workspaceId, id: idle.run.id })
        return row?.status === SubagentStatuses.EXPIRED
      })
    } finally {
      sweep.stop()
    }

    expect(await subagentService.getById({ workspaceId: ctx.workspaceId, id: fresh.run.id })).toMatchObject({
      status: SubagentStatuses.ACTIVE,
    })
    const patches = await statusEvents(idleChannel.id)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      actorType: AuthorTypes.SYSTEM,
      payload: { subagentId: idle.run.id, status: SubagentStatuses.EXPIRED },
    })
    expect(await statusEvents(freshChannel.id)).toHaveLength(0)

    // A second sweep matches nothing — the CAS is idempotent under concurrent sweeps.
    expect(await subagentService.expireIdleRuns()).toEqual([])

    // An expired run is requeueable, exactly like a failed one.
    expect(
      await subagentService.requeue({
        workspaceId: ctx.workspaceId,
        id: idle.run.id,
        parentStreamId: idleChannel.id,
        requeuedBy: { actorId: ctx.owner, actorType: AuthorTypes.USER },
      })
    ).toMatchObject({ status: SubagentStatuses.ACTIVE })
  })
})

/** The turn/orphan failure path as production wires it: the CAS rides the caller's transaction. */
async function failRun(threadStreamId: string, statusNote: string) {
  return withTransaction(pool, (client) =>
    subagentService.failByThreadStreamInTransaction(client, {
      workspaceId: ctx.workspaceId,
      threadStreamId,
      statusNote,
    })
  )
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for condition")
}
