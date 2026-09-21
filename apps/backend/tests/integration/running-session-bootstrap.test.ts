import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { AgentStepTypes } from "@threahq/types"
import { AgentSessionRepository, SessionStatuses } from "../../src/features/agents"
import { messageId, sessionId, stepId, streamId } from "../../src/lib/id"

describe("running-session bootstrap reads for a batch of joined streams", () => {
  let pool: Pool
  const runningStream = streamId()
  const busyStream = streamId()
  const doneStream = streamId()
  const idleStream = streamId()
  const streams = [runningStream, busyStream, doneStream, idleStream]
  const running = sessionId()
  const busy = sessionId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
    const seed = async (id: string, stream: string, status: (typeof SessionStatuses)[keyof typeof SessionStatuses]) =>
      AgentSessionRepository.insert(pool, {
        id,
        streamId: stream,
        personaId: "persona_bootstrap",
        triggerMessageId: messageId(),
        status,
      })
    await seed(running, runningStream, SessionStatuses.RUNNING)
    await seed(busy, busyStream, SessionStatuses.RUNNING)
    await seed(sessionId(), doneStream, SessionStatuses.COMPLETED)

    const steps = [AgentStepTypes.TOOL_CALL, AgentStepTypes.MESSAGE_SENT, AgentStepTypes.MESSAGE_EDITED]
    for (const stepType of steps) {
      await AgentSessionRepository.appendStep(pool, {
        id: stepId(),
        sessionId: busy,
        stepType,
        startedAt: new Date(),
      })
    }
  })

  afterAll(async () => {
    await pool.query("DELETE FROM agent_session_steps WHERE session_id = ANY($1)", [[running, busy]])
    await pool.query("DELETE FROM agent_sessions WHERE stream_id = ANY($1)", [streams])
    await pool.end()
  })

  test("finds only running sessions and counts steps the way the live emitter does", async () => {
    const sessions = await AgentSessionRepository.findRunningByStreams(pool, streams)
    const counts = await AgentSessionRepository.countStepsBySessions(pool, [running, busy])

    expect({
      sessions: Object.fromEntries(sessions.map((session) => [session.streamId, session.id])),
      counts: Object.fromEntries(counts),
    }).toEqual({
      sessions: { [runningStream]: running, [busyStream]: busy },
      counts: { [busy]: { stepCount: 3, messageCount: 2 } },
    })
  })
})
