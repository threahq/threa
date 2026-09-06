/**
 * A subagent whose runtime dies must not leave a card saying "waiting for you".
 *
 * Two independent ways a turn ends for good, each wired to the same CAS and each
 * covered here through the production seam rather than by calling the CAS
 * directly: the turn that throws inside `withCompanionSession`
 * (`onTerminalFailure`, wired in `PersonaAgent.run`), and the turn whose process
 * vanished so nothing throws at all (`onSessionFailed`, wired in `server.ts` on
 * the orphan sweep). Both must flip the run in the SAME transaction as the
 * session (INV-7).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { AuthorTypes, SubagentFailureReasons, SubagentStatuses } from "@threahq/types"
import { withCompanionSession } from "../../src/features/agents/companion"
import { AgentSessionRepository, SessionStatuses } from "../../src/features/agents"
import { createOrphanSessionCleanup } from "../../src/features/agents/orphan-session-cleanup"
import { StreamEventRepository } from "../../src/features/streams"
import { SubagentService } from "../../src/features/subagents"
import { messageId } from "../../src/lib/id"
import { setupIsolatedTestDatabase } from "./setup"
import { createParams, createSubagentTestContext, type SubagentTestContext } from "./subagent-support"

let pool: Pool
let cleanup: () => Promise<void>
let ctx: SubagentTestContext
let subagentService: SubagentService

/** The orphan sweep only emits to the trace dialog's room; nothing under test reads it. */
const io = { to: () => ({ emit: () => {} }) } as unknown as Server

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("subagent-session-failure")
  pool = db.pool
  cleanup = db.cleanup
  ctx = await createSubagentTestContext(pool, "sessionfail")
  subagentService = new SubagentService({ pool, streamService: ctx.streamService })
})

afterAll(async () => {
  await cleanup()
})

async function statusEvents(streamId: string) {
  return StreamEventRepository.list(pool, streamId, { types: ["subagent:status_changed"] })
}

describe("terminal turn failure", () => {
  test("a turn that throws in the subagent thread settles the run and patches the card", async () => {
    const channel = await ctx.createChannel({ slug: "turn-failure" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    const result = await withCompanionSession(
      {
        pool,
        triggerMessageId: `subagent_${run.id}`,
        streamId: threadStreamId,
        rootStreamId: channel.id,
        personaId: ctx.persona.id,
        personaName: ctx.persona.name,
        workspaceId: ctx.workspaceId,
        serverId: "test-server",
        initialSequence: 0n,
        // The wiring from `PersonaAgent.run`: present only because this stream
        // has a live run.
        onTerminalFailure: async (db) => {
          await subagentService.failByThreadStreamInTransaction(db, {
            workspaceId: ctx.workspaceId,
            threadStreamId,
            reason: SubagentFailureReasons.TURN_FAILED,
          })
        },
      },
      async () => {
        throw new Error("provider exploded")
      }
    )

    expect(result).toMatchObject({ status: "failed", willRetry: false })
    const settled = await subagentService.getById({ workspaceId: ctx.workspaceId, id: run.id })
    expect(settled).toMatchObject({ status: SubagentStatuses.FAILED })
    // A code, not prose: the backend never authors display text (INV-46), and a
    // system transition has no human actor to have written any.
    expect(settled?.statusNote).toBe(SubagentFailureReasons.TURN_FAILED)

    const patches = await statusEvents(channel.id)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      actorType: AuthorTypes.SYSTEM,
      payload: { subagentId: run.id, status: SubagentStatuses.FAILED },
    })
    // The session's own terminal event landed in the thread, in that same
    // transaction — the card and the trace tell one story.
    expect(await StreamEventRepository.list(pool, threadStreamId, { types: ["agent_session:failed"] })).toHaveLength(1)
  })

  test("a retryable attempt is not terminal and leaves the run alive", async () => {
    const channel = await ctx.createChannel({ slug: "turn-retry" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    const result = await withCompanionSession(
      {
        pool,
        triggerMessageId: `subagent_${run.id}`,
        streamId: threadStreamId,
        rootStreamId: channel.id,
        personaId: ctx.persona.id,
        personaName: ctx.persona.name,
        workspaceId: ctx.workspaceId,
        serverId: "test-server",
        initialSequence: 0n,
        attempt: 1,
        maxAttempts: 3,
        onTerminalFailure: async (db) => {
          await subagentService.failByThreadStreamInTransaction(db, {
            workspaceId: ctx.workspaceId,
            threadStreamId,
            reason: SubagentFailureReasons.TURN_FAILED,
          })
        },
      },
      async () => {
        throw new Error("transient")
      }
    )

    expect(result).toMatchObject({ status: "failed", willRetry: true })
    expect(await subagentService.getById({ workspaceId: ctx.workspaceId, id: run.id })).toMatchObject({
      status: SubagentStatuses.ACTIVE,
    })
    expect(await statusEvents(channel.id)).toHaveLength(0)
  })
})

describe("orphaned runtime", () => {
  test("the orphan sweep fails the run whose session it reaps", async () => {
    const channel = await ctx.createChannel({ slug: "orphan" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))
    const session = await AgentSessionRepository.insert(pool, {
      id: `sess_orphan_${run.id.slice(-8)}`,
      streamId: threadStreamId,
      personaId: ctx.persona.id,
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
    })
    await pool.query(`UPDATE agent_sessions SET heartbeat_at = NOW() - interval '10 minutes' WHERE id = $1`, [
      session.id,
    ])

    // The wiring from `server.ts`.
    const sweep = createOrphanSessionCleanup(pool, io, {
      intervalMs: 3_600_000,
      staleThresholdSeconds: 60,
      onSessionFailed: (tx, failed) =>
        subagentService
          .failByThreadStreamInTransaction(tx, {
            workspaceId: failed.workspaceId,
            threadStreamId: failed.streamId,
            reason: SubagentFailureReasons.SESSION_ORPHANED,
          })
          .then(() => undefined),
    })
    sweep.start()
    try {
      await waitFor(async () => {
        const row = await subagentService.getById({ workspaceId: ctx.workspaceId, id: run.id })
        return row?.status === SubagentStatuses.FAILED
      })
    } finally {
      sweep.stop()
    }

    expect(await AgentSessionRepository.findById(pool, session.id)).toMatchObject({ status: SessionStatuses.FAILED })
    expect(await subagentService.getById({ workspaceId: ctx.workspaceId, id: run.id })).toMatchObject({
      status: SubagentStatuses.FAILED,
      statusNote: SubagentFailureReasons.SESSION_ORPHANED,
    })
    expect(await statusEvents(channel.id)).toHaveLength(1)
  })
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for condition")
}
