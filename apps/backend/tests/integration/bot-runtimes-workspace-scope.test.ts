import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { setupTestDatabase, withTransaction } from "./setup"
import { BotInvocationRepository } from "../../src/features/bot-runtimes"
import { botInvocationActorSourceLockKey } from "../../src/features/bot-runtimes/repository"
import { botId, botInvocationId, streamId, userId, workspaceId } from "../../src/lib/id"

const WRITTEN_TABLES = ["bot_invocations", "agent_sessions", "streams"]

interface InvocationSeed {
  sourceMessageId: string
  workspaceId?: string
  streamId?: string
  botId?: string
  status?: string
  cancellationReason?: string
  sourceMessageRevision?: number
  trigger?: string
  createdAt?: Date
  claimToken?: string
  claimed?: { revision: number; expired?: boolean; attempts?: number }
}

describe("Bot runtime workspace scope (INV-8)", () => {
  let pool: Pool
  let wsA: string
  let wsB: string
  let author: string
  const tag = Math.random().toString(36).slice(2, 10)

  async function insertStream(ws: string) {
    const id = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, created_by, visibility) VALUES ($1, $2, 'scratchpad', $3, 'private')`,
      [id, ws, author]
    )
    return id
  }

  /** Inserts a fresh invocation, by default in the owning workspace on a fresh stream. */
  async function insertInvocation(seed: InvocationSeed) {
    const id = botInvocationId()
    const claimed = seed.claimed
    const expiry = claimed ? new Date(Date.now() + (claimed.expired ? -3_600_000 : 3_600_000)) : null
    await pool.query(
      `INSERT INTO bot_invocations (
         id, workspace_id, root_stream_id, active_stream_id, source_message_id, response_stream_id, actor_type, actor_id,
         trigger, required_capability, prompt_markdown, author_user_id, status, claim_token, claim_expires_at, attempts,
         claimed_source_message_revision, cancellation_reason, source_message_revision, claimed_by_instance_id,
         created_at
       ) VALUES ($1, $2, $3, $3, $4, $3, 'bot', $5, $15, 'active-scratchpad', 'prompt', $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($16::timestamptz, NOW()))`,
      [
        id,
        seed.workspaceId ?? wsA,
        seed.streamId ?? streamId(),
        seed.sourceMessageId,
        seed.botId ?? "bot_scope_default",
        author,
        claimed ? "claimed" : (seed.status ?? "pending"),
        seed.claimToken ?? (claimed ? `tok_${id}` : null),
        expiry,
        claimed?.attempts ?? 0,
        claimed?.revision ?? null,
        seed.cancellationReason ?? null,
        seed.sourceMessageRevision ?? 0,
        claimed ? "inst_scope" : null,
        seed.trigger ?? "active-scratchpad",
        seed.createdAt ?? null,
      ]
    )
    return id
  }

  async function insertSession(id: string, ws: string) {
    await pool.query(
      `INSERT INTO agent_sessions (id, stream_id, persona_id, trigger_message_id, status, workspace_id)
       VALUES ($1, $2, 'persona_scope', 'msg_scope_trigger', 'running', $3)`,
      [id, streamId(), ws]
    )
  }

  const idOf = (row: { id: string } | null) => row?.id ?? null
  const idsOf = (rows: { id: string }[]) => rows.map((row) => row.id).sort()

  /** The same call through the other workspace first, then through the owning one as the control. */
  async function reachedThrough<T>(call: (ws: string) => Promise<T>) {
    const other = await call(wsB)
    const own = await call(wsA)
    return { other, own }
  }

  async function isAdvisoryLocked(key: string) {
    const result = await pool.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired`,
      [key]
    )
    return !result.rows[0]!.acquired
  }

  /** The call's result and whether `key` is still held by its transaction, once through each workspace. */
  function lockedThrough<T>(key: string, call: (client: PoolClient, ws: string) => Promise<T>) {
    return reachedThrough((ws) =>
      withTransaction(pool, async (client) => {
        const result = await call(client, ws)
        return { result, lockHeld: await isAdvisoryLocked(key) }
      })
    )
  }

  async function invocationStates(ids: string[]) {
    const result = await pool.query<{
      id: string
      status: string
      prompt_markdown: string
      source_message_revision: number
      claimed_source_message_revision: number | null
      cancellation_reason: string | null
      lease_extended: boolean
    }>(
      `SELECT id, status, prompt_markdown, source_message_revision, claimed_source_message_revision, cancellation_reason,
              COALESCE(claim_expires_at > NOW() + INTERVAL '90 minutes', FALSE) AS lease_extended
       FROM bot_invocations WHERE id = ANY($1) ORDER BY id`,
      [ids]
    )
    return Object.fromEntries(
      result.rows.map((row) => [
        row.id,
        {
          status: row.status,
          promptMarkdown: row.prompt_markdown,
          sourceRevision: row.source_message_revision,
          claimedRevision: row.claimed_source_message_revision,
          cancellationReason: row.cancellation_reason,
          leaseExtended: row.lease_extended,
        },
      ])
    )
  }

  async function cancelBySource(db: Pool | PoolClient, ws: string, source: string) {
    const result = await BotInvocationRepository.cancelActiveBySource(db, {
      workspaceId: ws,
      sourceMessageId: source,
      reason: "source_deleted",
    })
    return { transitioned: idsOf(result.transitioned), sessionRepairCandidates: idsOf(result.sessionRepairCandidates) }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = workspaceId()
    wsB = workspaceId()
    author = userId()
  })

  afterAll(async () => {
    for (const table of WRITTEN_TABLES) {
      await pool.query(`DELETE FROM ${table} WHERE workspace_id = ANY($1)`, [[wsA, wsB]])
    }
    await pool.end()
  })

  describe("deleted-source session repair lookups", () => {
    const sources = { first: `${tag}_s0`, second: `${tag}_s2`, cross: `${tag}_s1`, other: `${tag}_b1` }

    beforeAll(async () => {
      const stream = await insertStream(wsA)
      const streamInB = await insertStream(wsB)
      const seed = async (ws: string, source: string, sessionWorkspace: string, stream: string) => {
        const id = await insertInvocation({
          workspaceId: ws,
          streamId: stream,
          sourceMessageId: source,
          botId: botId(),
          status: "cancelled",
          cancellationReason: "source_deleted",
        })
        await insertSession(id, sessionWorkspace)
      }
      await seed(wsA, sources.first, wsA, stream)
      await seed(wsA, sources.second, wsA, stream)
      await seed(wsA, sources.cross, wsB, stream)
      await seed(wsB, sources.other, wsB, streamInB)
    })

    test("should skip an invocation whose session belongs to another workspace when sweeping every workspace", async () => {
      const swept = await BotInvocationRepository.findDeletedSourcesWithRunningSessions(pool, 100_000)

      expect(
        swept
          .filter((row) => row.workspaceId === wsA || row.workspaceId === wsB)
          .map((row) => `${row.workspaceId}:${row.sourceMessageId}`)
          .sort()
      ).toEqual([`${wsA}:${sources.first}`, `${wsA}:${sources.second}`, `${wsB}:${sources.other}`].sort())
    })
  })

  describe("bot invocation lock identity", () => {
    const actorLockKey = (ws: string, source: string, bot: string) =>
      botInvocationActorSourceLockKey({ workspaceId: ws, sourceMessageId: source, actorType: "bot", actorId: bot })

    test("should hold the source's lock only when the claim is in the given workspace when reading a claim's control state", async () => {
      const bot = botId()
      const source = `${tag}_lc`
      const invocation = await insertInvocation({ sourceMessageId: source, botId: bot, claimed: { revision: 1 } })

      const control = await lockedThrough(actorLockKey(wsA, source, bot), async (client, ws) =>
        idOf(
          await BotInvocationRepository.findClaimControl(client, {
            workspaceId: ws,
            botId: bot,
            invocationId: invocation,
            instanceId: "inst_scope",
            claimToken: `tok_${invocation}`,
          })
        )
      )

      expect(control).toEqual({
        other: { result: null, lockHeld: false },
        own: { result: invocation, lockHeld: true },
      })
    })

    test("should cancel and lock only the given workspace's routes when a source's routing changes", async () => {
      const bot = botId()
      const source = `${tag}_lr`
      const invocation = await insertInvocation({ sourceMessageId: source, botId: bot })

      const cancelled = await lockedThrough(actorLockKey(wsA, source, bot), async (client, ws) =>
        idsOf(
          await BotInvocationRepository.cancelActiveRoutesNotDesired(client, {
            workspaceId: ws,
            sourceMessageId: source,
            sourceMessageRevision: 1,
            desiredRoutes: [],
          })
        )
      )

      expect({ cancelled, stored: await invocationStates([invocation]) }).toEqual({
        cancelled: {
          other: { result: [], lockHeld: false },
          own: { result: [invocation], lockHeld: true },
        },
        stored: {
          [invocation]: {
            status: "cancelled",
            promptMarkdown: "prompt",
            sourceRevision: 1,
            claimedRevision: null,
            cancellationReason: "routing_changed",
            leaseExtended: false,
          },
        },
      })
    })

    test("should cancel and lock only the given workspace's invocations when a source is deleted", async () => {
      const bot = botId()
      const source = `${tag}_ls`
      const invocation = await insertInvocation({ sourceMessageId: source, botId: bot })

      const cancelled = await lockedThrough(actorLockKey(wsA, source, bot), (client, ws) =>
        cancelBySource(client, ws, source)
      )

      expect(cancelled).toEqual({
        other: { result: { transitioned: [], sessionRepairCandidates: [] }, lockHeld: false },
        own: { result: { transitioned: [invocation], sessionRepairCandidates: [] }, lockHeld: true },
      })
    })

    test("should park and lock only the given workspace's exhausted claims when sweeping a bot", async () => {
      const bot = botId()
      const source = `${tag}_lp`
      const invocation = await insertInvocation({
        sourceMessageId: source,
        botId: bot,
        trigger: "session-control",
        claimed: { revision: 0, expired: true, attempts: 5 },
      })

      const parked = await lockedThrough(actorLockKey(wsA, source, bot), async (client, ws) =>
        idsOf(await BotInvocationRepository.parkExhausted(client, { workspaceId: ws, botId: bot, maxAttempts: 5 }))
      )

      expect(parked).toEqual({
        other: { result: [], lockHeld: false },
        own: { result: [invocation], lockHeld: true },
      })
    })
  })

  describe("bot invocation recording", () => {
    const recordingParams = (o: {
      id: string
      workspaceId: string
      stream: string
      source: string
      bot: string
      revision: number
    }) => ({
      id: o.id,
      workspaceId: o.workspaceId,
      rootStreamId: o.stream,
      activeStreamId: o.stream,
      sourceMessageId: o.source,
      responseStreamId: o.stream,
      actorType: "bot" as const,
      actorId: o.bot,
      trigger: "active-scratchpad" as const,
      requiredCapability: "active-scratchpad" as const,
      promptMarkdown: "prompt",
      sourceMessageRevision: o.revision,
      authorUserId: author,
      mentionedActorSlugs: [],
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      metadata: {},
    })

    test("should insert when the terminal turn for the source is in another workspace when recording an invocation", async () => {
      const bot = botId()
      const stream = streamId()
      const source = `${tag}_ii1`
      const terminal = await insertInvocation({
        streamId: stream,
        sourceMessageId: source,
        botId: bot,
        status: "completed",
        claimToken: "tok_ii1",
        sourceMessageRevision: 3,
      })
      const insertedInB = botInvocationId()

      const recorded = await reachedThrough(async (ws) => {
        const result = await BotInvocationRepository.insertIdempotent(
          pool,
          recordingParams({
            id: ws === wsB ? insertedInB : botInvocationId(),
            workspaceId: ws,
            stream,
            source,
            bot,
            revision: 2,
          })
        )
        return { id: result.invocation.id, wasNewlyInserted: result.wasNewlyInserted }
      })

      expect(recorded).toEqual({
        other: { id: insertedInB, wasNewlyInserted: true },
        own: { id: terminal, wasNewlyInserted: false },
      })
    })

    test("should return the terminal turn of its own workspace when a newer one for the same source is in another workspace", async () => {
      const bot = botId()
      const stream = streamId()
      const source = `${tag}_ii2`
      const terminal = {
        streamId: stream,
        sourceMessageId: source,
        botId: bot,
        status: "completed",
        claimToken: "tok_ii2",
        sourceMessageRevision: 3,
      }
      const olderInB = await insertInvocation({
        ...terminal,
        workspaceId: wsB,
        createdAt: new Date(Date.now() - 600_000),
      })
      const newerInA = await insertInvocation({
        ...terminal,
        workspaceId: wsA,
        createdAt: new Date(Date.now() - 60_000),
      })

      const recorded = await reachedThrough(async (ws) => {
        const result = await BotInvocationRepository.insertIdempotent(
          pool,
          recordingParams({ id: botInvocationId(), workspaceId: ws, stream, source, bot, revision: 2 })
        )
        return { id: result.invocation.id, wasNewlyInserted: result.wasNewlyInserted }
      })

      expect(recorded).toEqual({
        other: { id: olderInB, wasNewlyInserted: false },
        own: { id: newerInA, wasNewlyInserted: false },
      })
    })

    test("should compare routing against its own workspace's pending invocation when a source is re-routed", async () => {
      const bot = botId()
      const source = `${tag}_ii3`
      const [lowerWorkspace, higherWorkspace] = [wsA, wsB].sort()
      const oldStream = streamId()
      const newStream = streamId()
      const pendingIn = (ws: string, stream: string) =>
        insertInvocation({
          workspaceId: ws,
          streamId: stream,
          sourceMessageId: source,
          botId: bot,
          sourceMessageRevision: 1,
        })
      await pendingIn(lowerWorkspace!, newStream)
      const own = await pendingIn(higherWorkspace!, oldStream)

      const result = await BotInvocationRepository.insertIdempotent(
        pool,
        recordingParams({
          id: botInvocationId(),
          workspaceId: higherWorkspace!,
          stream: newStream,
          source,
          bot,
          revision: 2,
        })
      )

      expect({
        id: result.invocation.id,
        wasNewlyInserted: result.wasNewlyInserted,
        routingDestinationChanged: result.routingDestinationChanged,
        activeStreamId: result.invocation.activeStreamId,
      }).toEqual({ id: own, wasNewlyInserted: false, routingDestinationChanged: true, activeStreamId: newStream })
    })
  })
})
