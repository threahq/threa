import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import {
  AgentSessionRepository,
  SessionStatuses,
  failSessionWithLifecycle,
  withCompanionSession,
} from "../../src/features/agents"
import { streamId, workspaceId, personaId, messageId, sessionId, stepId, userId } from "../../src/lib/id"
import { AgentStepTypes, type AgentToolEffect } from "@threa/types"

const MEMO_EFFECT: AgentToolEffect = { kind: "memo", label: "Deploy runbook", target: "memo_01" }
const SETTINGS_EFFECT: AgentToolEffect = {
  kind: "settings",
  label: "Theme",
  target: "theme",
  before: "light",
  after: "dark",
}

describe("session lifecycle payloads carry the turn's effects", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM agent_session_steps")
    await pool.query("DELETE FROM agent_sessions")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
    await pool.query("DELETE FROM outbox")
  })

  async function writeStep(sessionId: string, stepNumber: number, effects?: AgentToolEffect[]): Promise<string> {
    const id = stepId()
    await AgentSessionRepository.upsertStep(pool, {
      id,
      sessionId,
      stepNumber,
      stepType: effects ? AgentStepTypes.TOOL_CALL : AgentStepTypes.WEB_SEARCH,
      startedAt: new Date(),
    })
    if (effects) await AgentSessionRepository.updateStep(pool, id, { effects })
    return id
  }

  async function eventPayload(eventType: string): Promise<any> {
    const { rows } = await pool.query<{ payload: any }>(
      "SELECT payload FROM stream_events WHERE event_type = $1 ORDER BY sequence DESC LIMIT 1",
      [eventType]
    )
    return rows[0]?.payload
  }

  function runSession(params: { attempt?: number; maxAttempts?: number }, work: (sessionId: string) => Promise<void>) {
    return withCompanionSession(
      {
        pool,
        triggerMessageId: messageId(),
        streamId: streamId(),
        personaId: personaId(),
        personaName: "Ariadne",
        workspaceId: workspaceId(),
        serverId: "test-server",
        initialSequence: 1n,
        ...params,
      },
      async (session) => {
        await work(session.id)
        return { messagesSent: 1, sentMessageIds: [messageId()], lastSeenSequence: 2n }
      }
    )
  }

  test("a completed session's stream event carries both steps' effects in step order", async () => {
    const result = await runSession({}, async (sessionId) => {
      await writeStep(sessionId, 1, [MEMO_EFFECT])
      await writeStep(sessionId, 2, [SETTINGS_EFFECT])
    })
    expect(result.status).toBe("completed")

    const payload = await eventPayload("agent_session:completed")
    expect(payload.effects).toEqual([MEMO_EFFECT, SETTINGS_EFFECT])
  })

  test("a session with only read-only steps emits no effects", async () => {
    await runSession({}, async (sessionId) => {
      await writeStep(sessionId, 1)
      await writeStep(sessionId, 2)
    })

    const payload = await eventPayload("agent_session:completed")
    expect(payload.effects).toEqual([])
  })

  test("the outbox row and the stream-event row carry the same payload", async () => {
    await runSession({}, async (sessionId) => {
      await writeStep(sessionId, 1, [MEMO_EFFECT])
    })

    const streamEventPayload = await eventPayload("agent_session:completed")
    const { rows } = await pool.query<{ payload: any }>(
      "SELECT payload FROM outbox WHERE event_type = 'agent_session:completed' ORDER BY id DESC LIMIT 1"
    )
    expect(rows[0]!.payload.event.payload).toEqual(streamEventPayload)
  })

  test("a turn that saved a memo and then threw still surfaces the memo on failed", async () => {
    const result = await runSession({}, async (sessionId) => {
      await writeStep(sessionId, 1, [MEMO_EFFECT])
      throw new Error("model exploded")
    })
    expect(result.status).toBe("failed")

    const payload = await eventPayload("agent_session:failed")
    expect(payload.effects).toEqual([MEMO_EFFECT])
  })

  test("an interrupted attempt's effects survive the retry that wipes the step rows", async () => {
    let attemptOneSessionId = ""
    const first = await runSession({ attempt: 0, maxAttempts: 3 }, async (sessionId) => {
      attemptOneSessionId = sessionId
      await writeStep(sessionId, 1, [SETTINGS_EFFECT])
      throw new Error("transient")
    })
    expect(first).toMatchObject({ status: "failed", willRetry: true })

    const interrupted = await eventPayload("agent_session:interrupted")
    expect(interrupted.effects).toEqual([SETTINGS_EFFECT])

    // The retry reuses step_number 1; upsertStep's ON CONFLICT resets effects to
    // NULL, so attempt 1's write is gone from the step rows from here on.
    await writeStep(attemptOneSessionId, 1)
    const steps = await AgentSessionRepository.findStepsBySession(pool, attemptOneSessionId)
    expect(steps.map((s) => s.effects)).toEqual([undefined])

    // The durable interrupted event is now the only record of it.
    expect((await eventPayload("agent_session:interrupted")).effects).toEqual([SETTINGS_EFFECT])
  })
})

/**
 * The crash path. A turn's steps commit as it runs, but if the process dies
 * before the completion phase, the in-process emitter never fires and the
 * orphan sweeper writes the terminal event instead. A settings write has no
 * bespoke timeline card to fall back on, so effects missing here means the
 * write is permanently invisible in the conversation.
 */
describe("an orphaned session's terminal event carries its effects", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM agent_session_steps")
    await pool.query("DELETE FROM agent_sessions")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
    await pool.query("DELETE FROM outbox")
    await pool.query("DELETE FROM streams")
  })

  test("surfaces a write made before the process died", async () => {
    const testStreamId = streamId()
    const testWorkspaceId = workspaceId()
    const testSessionId = sessionId()
    const testPersonaId = personaId()

    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)`,
      [testStreamId, testWorkspaceId, userId()]
    )
    await AgentSessionRepository.insert(pool, {
      id: testSessionId,
      streamId: testStreamId,
      personaId: testPersonaId,
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
    })

    const writtenStepId = stepId()
    await AgentSessionRepository.upsertStep(pool, {
      id: writtenStepId,
      sessionId: testSessionId,
      stepNumber: 1,
      stepType: AgentStepTypes.TOOL_CALL,
      startedAt: new Date(),
    })
    await AgentSessionRepository.updateStep(pool, writtenStepId, {
      effects: [{ kind: "settings", target: "theme", before: "light", after: "dark" }],
    })

    const io = { to: () => ({ emit: () => {} }) } as never

    const won = await failSessionWithLifecycle(
      pool,
      io,
      { id: testSessionId, streamId: testStreamId, personaId: testPersonaId },
      "Session abandoned"
    )
    expect(won).toBe(true)

    const { rows } = await pool.query<{ payload: any }>(
      "SELECT payload FROM stream_events WHERE event_type = 'agent_session:failed' ORDER BY sequence DESC LIMIT 1"
    )
    expect(rows[0]?.payload.effects).toEqual([{ kind: "settings", target: "theme", before: "light", after: "dark" }])
  })
})
