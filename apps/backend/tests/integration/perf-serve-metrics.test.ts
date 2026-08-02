import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import type { Request, Response } from "express"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { SyncService, SyncLogRepository, createSyncHandlers } from "../../src/features/sync"
import { userId, workspaceId } from "../../src/lib/id"
import {
  syncCatchupDurationSeconds,
  syncCatchupEntriesReturned,
  syncCatchupPayloadBytes,
} from "../../src/lib/observability"

interface HistogramSnapshot {
  count: number
  sum: number
}

async function snapshot(
  metric: typeof syncCatchupPayloadBytes,
  labels: Record<string, string> = {}
): Promise<HistogramSnapshot> {
  const collected = await metric.get()
  const matches = (sample: (typeof collected.values)[number]) =>
    Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
  const find = (suffix: string) =>
    collected.values.find((sample) => sample.metricName?.endsWith(suffix) && matches(sample))?.value ?? 0
  return { count: find("_count"), sum: find("_sum") }
}

function makeReqRes(after: string) {
  const req = {
    user: { id: "usr_ignored", role: "member" },
    workspaceId: "",
    query: { after },
  } as unknown as Request
  const sent: string[] = []
  const send = (body: string) => {
    sent.push(body)
  }
  const res = { type: () => ({ send }), send, locals: {} } as unknown as Response
  return { req, res, sent }
}

describe("catch-up serve metrics", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserId: string
  let prunedWorkspaceId: string
  let prunedUserId: string

  async function seedWorkspace(): Promise<{ workspace: string; user: string }> {
    const workspace = workspaceId()
    let user = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: workspace,
        name: "Serve Metrics WS",
        slug: `serve-metrics-${workspace}`,
        createdBy: user,
      })
      user = (await addTestMember(client, workspace, user)).id
    })

    const outboxBase = BigInt(Date.now()) * 1000n
    await SyncLogRepository.appendForWorkspace(
      pool,
      workspace,
      Array.from({ length: 4 }, (_, index) => ({
        outboxEventId: outboxBase + BigInt(index),
        eventType: "stream:created",
        groups: ["workspace"],
        payload: { workspaceId: workspace, streamId: `stream_serve_${index}`, filler: "x".repeat(200) },
      }))
    )

    return { workspace, user }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    const primary = await seedWorkspace()
    testWorkspaceId = primary.workspace
    testUserId = primary.user
    // The pruned-cursor test raises a retention floor, which would make the
    // first test's catch-up return nothing if they shared a workspace.
    const pruned = await seedWorkspace()
    prunedWorkspaceId = pruned.workspace
    prunedUserId = pruned.user
  })

  afterAll(async () => {
    const workspaces = [testWorkspaceId, prunedWorkspaceId]
    await pool.query(`DELETE FROM sync_log WHERE workspace_id = ANY($1)`, [workspaces])
    await pool.query(`DELETE FROM sync_log_retention_state WHERE workspace_id = ANY($1)`, [workspaces])
    await pool.query(`DELETE FROM workspace_sync_sequences WHERE workspace_id = ANY($1)`, [workspaces])
    await pool.end()
  })

  test("catch-up serve observes entries, bytes and duration for a real catch-up", async () => {
    const before = {
      entries: await snapshot(syncCatchupEntriesReturned, { requires_bootstrap: "false" }),
      bytes: await snapshot(syncCatchupPayloadBytes),
      duration: await snapshot(syncCatchupDurationSeconds),
    }

    const handlers = createSyncHandlers({ syncService: new SyncService({ pool }) })
    const { req, res, sent } = makeReqRes("0")
    req.workspaceId = testWorkspaceId
    req.user!.id = testUserId
    await handlers.catchUp(req, res)

    const body = JSON.parse(sent[0]) as { entries: unknown[] }
    expect(body.entries).toHaveLength(4)

    const entries = await snapshot(syncCatchupEntriesReturned, { requires_bootstrap: "false" })
    const bytes = await snapshot(syncCatchupPayloadBytes)
    const duration = await snapshot(syncCatchupDurationSeconds)

    expect(entries.count).toBe(before.entries.count + 1)
    expect(entries.sum).toBe(before.entries.sum + 4)
    expect(bytes.count).toBe(before.bytes.count + 1)
    expect(bytes.sum).toBe(before.bytes.sum + Buffer.byteLength(sent[0]))
    expect(duration.count).toBe(before.duration.count + 1)
  })

  test("a pruned cursor is labelled requires_bootstrap=true", async () => {
    // Stand in for a completed retention prune: the floor, not the deletion, is
    // what catch-up reads to decide the cursor needs a full bootstrap.
    const { head } = await SyncLogRepository.getHeadAndRetainedFrom(pool, prunedWorkspaceId)
    await pool.query(
      `INSERT INTO sync_log_retention_state (workspace_id, retained_from)
       VALUES ($1, $2)
       ON CONFLICT (workspace_id) DO UPDATE SET retained_from = EXCLUDED.retained_from`,
      [prunedWorkspaceId, head.toString()]
    )
    const { retainedFrom } = await SyncLogRepository.getHeadAndRetainedFrom(pool, prunedWorkspaceId)
    expect(retainedFrom).toBeGreaterThan(0n)

    const before = await snapshot(syncCatchupEntriesReturned, { requires_bootstrap: "true" })

    const handlers = createSyncHandlers({ syncService: new SyncService({ pool }) })
    const { req, res, sent } = makeReqRes("0")
    req.workspaceId = prunedWorkspaceId
    req.user!.id = prunedUserId
    await handlers.catchUp(req, res)

    expect(JSON.parse(sent[0])).toMatchObject({ entries: [], requiresBootstrap: true })
    const after = await snapshot(syncCatchupEntriesReturned, { requires_bootstrap: "true" })
    expect(after.count).toBe(before.count + 1)
    expect(after.sum).toBe(before.sum)
  })
})
