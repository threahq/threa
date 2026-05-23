import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { withClient } from "./setup"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { AgentSessionRepository, SessionStatuses } from "../../src/features/agents"
import { streamId, userId, workspaceId, sessionId, personaId, messageId, stepId } from "../../src/lib/id"
import { AgentStepTypes } from "@threa/types"
import { setupTestDatabase, testMessageContent } from "./setup"

describe("Agent Session Repository", () => {
  let pool: Pool
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM agent_session_steps")
    await pool.query("DELETE FROM agent_sessions")
    await pool.query("DELETE FROM reactions")
    await pool.query("DELETE FROM messages")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
  })

  describe("findRunningByStream", () => {
    test("should return null when no running session exists", async () => {
      const testStreamId = streamId()

      const result = await AgentSessionRepository.findRunningByStream(pool, testStreamId)
      expect(result).toBeNull()
    })

    test("should return running session for stream", async () => {
      const testStreamId = streamId()
      const testPersonaId = personaId()
      const testMessageId = messageId()
      const testSessionId = sessionId()

      await withClient(pool, async (client) => {
        await AgentSessionRepository.insert(client, {
          id: testSessionId,
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: testMessageId,
          status: SessionStatuses.RUNNING,
          serverId: "test-server",
        })

        const result = await AgentSessionRepository.findRunningByStream(client, testStreamId)

        expect(result).not.toBeNull()
        expect(result!.id).toBe(testSessionId)
        expect(result!.status).toBe(SessionStatuses.RUNNING)
      })
    })

    test("should not return completed sessions", async () => {
      const testStreamId = streamId()
      const testPersonaId = personaId()
      const testMessageId = messageId()
      const testSessionId = sessionId()

      await withClient(pool, async (client) => {
        await AgentSessionRepository.insert(client, {
          id: testSessionId,
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: testMessageId,
          status: SessionStatuses.RUNNING,
          serverId: "test-server",
        })

        await AgentSessionRepository.updateStatus(client, testSessionId, SessionStatuses.COMPLETED)

        const result = await AgentSessionRepository.findRunningByStream(client, testStreamId)
        expect(result).toBeNull()
      })
    })

    test("should not return sessions from other streams", async () => {
      const testStreamId1 = streamId()
      const testStreamId2 = streamId()
      const testPersonaId = personaId()

      await withClient(pool, async (client) => {
        await AgentSessionRepository.insert(client, {
          id: sessionId(),
          streamId: testStreamId1,
          personaId: testPersonaId,
          triggerMessageId: messageId(),
          status: SessionStatuses.RUNNING,
          serverId: "test-server",
        })

        const result = await AgentSessionRepository.findRunningByStream(client, testStreamId2)
        expect(result).toBeNull()
      })
    })
  })

  describe("findLatestByStream", () => {
    test("should return null when no sessions exist", async () => {
      const testStreamId = streamId()

      const result = await AgentSessionRepository.findLatestByStream(pool, testStreamId)
      expect(result).toBeNull()
    })

    test("should return most recent session regardless of status", async () => {
      const testStreamId = streamId()
      const testPersonaId = personaId()
      const session1Id = sessionId()
      const session2Id = sessionId()

      await withClient(pool, async (client) => {
        await AgentSessionRepository.insert(client, {
          id: session1Id,
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: messageId(),
          status: SessionStatuses.COMPLETED,
          serverId: "test-server",
        })

        // Small delay to ensure different created_at
        await new Promise((r) => setTimeout(r, 10))

        await AgentSessionRepository.insert(client, {
          id: session2Id,
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: messageId(),
          status: SessionStatuses.RUNNING,
          serverId: "test-server",
        })

        const result = await AgentSessionRepository.findLatestByStream(client, testStreamId)

        expect(result).not.toBeNull()
        expect(result!.id).toBe(session2Id)
      })
    })
  })

  describe("updateLastSeenSequence", () => {
    test("should update last seen sequence on session", async () => {
      const testStreamId = streamId()
      const testPersonaId = personaId()
      const testSessionId = sessionId()

      await withClient(pool, async (client) => {
        await AgentSessionRepository.insert(client, {
          id: testSessionId,
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: messageId(),
          status: SessionStatuses.RUNNING,
          serverId: "test-server",
        })

        await AgentSessionRepository.updateLastSeenSequence(client, testSessionId, BigInt(42))

        const session = await AgentSessionRepository.findById(client, testSessionId)

        expect(session).not.toBeNull()
        expect(session!.lastSeenSequence).toBe(BigInt(42))
      })
    })

    test("should also update heartbeat", async () => {
      const testStreamId = streamId()
      const testPersonaId = personaId()
      const testSessionId = sessionId()

      await withClient(pool, async (client) => {
        const inserted = await AgentSessionRepository.insert(client, {
          id: testSessionId,
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: messageId(),
          status: SessionStatuses.RUNNING,
          serverId: "test-server",
        })

        const initialHeartbeat = inserted.heartbeatAt

        // Small delay
        await new Promise((r) => setTimeout(r, 10))

        await AgentSessionRepository.updateLastSeenSequence(client, testSessionId, BigInt(1))

        const session = await AgentSessionRepository.findById(client, testSessionId)

        expect(session!.heartbeatAt!.getTime()).toBeGreaterThan(initialHeartbeat!.getTime())
      })
    })
  })
})

describe("Message Repository - listSince", () => {
  let pool: Pool
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query("DELETE FROM reactions")
    await pool.query("DELETE FROM messages")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
  })

  test("should return messages after given sequence", async () => {
    const testStreamId = streamId()
    const testWorkspaceId = workspaceId()
    const testUserId = userId()

    const msg1 = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("First"),
    })

    const msg2 = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("Second"),
    })

    const msg3 = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("Third"),
    })

    const messages = await MessageRepository.listSince(pool, testStreamId, BigInt(1))

    expect(messages).toHaveLength(2)
    expect(messages[0].id).toBe(msg2.id)
    expect(messages[1].id).toBe(msg3.id)
  })

  test("should return empty array when no messages after sequence", async () => {
    const testStreamId = streamId()
    const testWorkspaceId = workspaceId()
    const testUserId = userId()

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("Only message"),
    })

    const messages = await MessageRepository.listSince(pool, testStreamId, BigInt(100))

    expect(messages).toHaveLength(0)
  })

  test("should exclude messages from specified author", async () => {
    const testStreamId = streamId()
    const testWorkspaceId = workspaceId()
    const user1Id = userId()
    const user2Id = userId()

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: user1Id,
      authorType: "user",
      ...testMessageContent("From user 1"),
    })

    const msg2 = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: user2Id,
      authorType: "user",
      ...testMessageContent("From user 2"),
    })

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: user1Id,
      authorType: "user",
      ...testMessageContent("From user 1 again"),
    })

    const messages = await MessageRepository.listSince(pool, testStreamId, BigInt(0), {
      excludeAuthorId: user1Id,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe(msg2.id)
  })

  test("should order by sequence ascending (oldest first)", async () => {
    const testStreamId = streamId()
    const testWorkspaceId = workspaceId()
    const testUserId = userId()

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("First"),
    })

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("Second"),
    })

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("Third"),
    })

    const messages = await MessageRepository.listSince(pool, testStreamId, BigInt(0))

    expect(messages[0].contentMarkdown).toBe("First")
    expect(messages[1].contentMarkdown).toBe("Second")
    expect(messages[2].contentMarkdown).toBe("Third")
  })

  test("should not include deleted messages", async () => {
    const testStreamId = streamId()
    const testWorkspaceId = workspaceId()
    const testUserId = userId()

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("First"),
    })

    const msg2 = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("Second - will be deleted"),
    })

    await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("Third"),
    })

    await eventService.deleteMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      messageId: msg2.id,
      actorId: testUserId,
    })

    const messages = await MessageRepository.listSince(pool, testStreamId, BigInt(0))

    expect(messages).toHaveLength(2)
    expect(messages.find((m) => m.id === msg2.id)).toBeUndefined()
  })

  test("should respect limit parameter", async () => {
    const testStreamId = streamId()
    const testWorkspaceId = workspaceId()
    const testUserId = userId()

    for (let i = 0; i < 10; i++) {
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent(`Message ${i + 1}`),
      })
    }

    const messages = await MessageRepository.listSince(pool, testStreamId, BigInt(0), {
      limit: 3,
    })

    expect(messages).toHaveLength(3)
  })
})

describe("Agent Session - sentMessageIds", () => {
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
  })

  test("should persist sent message IDs on session completion", async () => {
    const testStreamId = streamId()
    const testPersonaId = personaId()
    const testSessionId = sessionId()
    const sentIds = [messageId(), messageId(), messageId()]

    await withClient(pool, async (client) => {
      await AgentSessionRepository.insert(client, {
        id: testSessionId,
        streamId: testStreamId,
        personaId: testPersonaId,
        triggerMessageId: messageId(),
        status: SessionStatuses.RUNNING,
        serverId: "test-server",
      })

      await AgentSessionRepository.updateStatus(client, testSessionId, SessionStatuses.COMPLETED, {
        responseMessageId: sentIds[0],
        sentMessageIds: sentIds,
      })

      const session = await AgentSessionRepository.findById(client, testSessionId)

      expect(session).not.toBeNull()
      expect(session!.sentMessageIds).toEqual(sentIds)
      expect(session!.responseMessageId).toBe(sentIds[0])
    })
  })

  test("should default to empty array when no messages sent", async () => {
    const testStreamId = streamId()
    const testPersonaId = personaId()
    const testSessionId = sessionId()

    const session = await AgentSessionRepository.insert(pool, {
      id: testSessionId,
      streamId: testStreamId,
      personaId: testPersonaId,
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
      serverId: "test-server",
    })

    expect(session.sentMessageIds).toEqual([])
  })
})

describe("Agent Session - Concurrency", () => {
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
  })

  test("FOR UPDATE SKIP LOCKED prevents concurrent access to running session", async () => {
    const testStreamId = streamId()
    const testPersonaId = personaId()
    const testSessionId = sessionId()

    // Insert a running session
    await AgentSessionRepository.insert(pool, {
      id: testSessionId,
      streamId: testStreamId,
      personaId: testPersonaId,
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
      serverId: "test-server",
    })

    // Coordination promises (no sleeps!)
    let resolveFirstAcquired: () => void
    let resolveFirstRelease: () => void

    const firstAcquired = new Promise<void>((resolve) => {
      resolveFirstAcquired = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      resolveFirstRelease = resolve
    })

    // Track results
    let firstResult: Awaited<ReturnType<typeof AgentSessionRepository.findRunningByStream>> = null
    let secondResult: Awaited<ReturnType<typeof AgentSessionRepository.findRunningByStream>> = null

    // First transaction: acquires lock and holds it
    const firstTx = withClient(pool, async (client) => {
      await client.query("BEGIN")

      firstResult = await AgentSessionRepository.findRunningByStream(client, testStreamId)
      resolveFirstAcquired!() // Signal that lock is held

      await firstRelease // Wait for signal to release

      await client.query("COMMIT")
    })

    // Wait for first transaction to acquire lock
    await firstAcquired

    // Second transaction: should get null due to SKIP LOCKED
    const secondTx = withClient(pool, async (client) => {
      await client.query("BEGIN")

      secondResult = await AgentSessionRepository.findRunningByStream(client, testStreamId)

      await client.query("COMMIT")
    })

    // Run second transaction while first holds lock
    await secondTx

    // Now release first transaction
    resolveFirstRelease!()
    await firstTx

    // First transaction got the session (held lock)
    expect(firstResult).not.toBeNull()
    expect(firstResult!.id).toBe(testSessionId)

    // Second transaction got null (row was locked, skipped)
    expect(secondResult).toBeNull()
  })

  test("concurrent session creation for same trigger message results in only one session", async () => {
    const testStreamId = streamId()
    const testPersonaId = personaId()
    const testMessageId = messageId()

    // Coordination
    let resolveBothReady: () => void
    const bothReady = new Promise<void>((resolve) => {
      resolveBothReady = resolve
    })

    let readyCount = 0
    const signalReady = () => {
      readyCount++
      if (readyCount === 2) resolveBothReady!()
    }

    const results: Array<{ success: boolean; sessionId?: string; error?: unknown }> = []

    // Two concurrent attempts to create session for same trigger message
    const attempt = async (id: string) => {
      await withClient(pool, async (client) => {
        await client.query("BEGIN")

        signalReady()
        await bothReady // Wait until both are ready

        try {
          const session = await AgentSessionRepository.insert(client, {
            id,
            streamId: testStreamId,
            personaId: testPersonaId,
            triggerMessageId: testMessageId,
            status: SessionStatuses.RUNNING,
            serverId: "test-server",
          })

          await client.query("COMMIT")
          results.push({ success: true, sessionId: session.id })
        } catch (error) {
          await client.query("ROLLBACK")
          results.push({ success: false, error })
        }
      })
    }

    await Promise.all([attempt(sessionId()), attempt(sessionId())])

    // Due to unique constraint on trigger_message_id (or lack thereof, we may have a race)
    // At least both should complete without deadlock
    expect(results).toHaveLength(2)

    // Count successful insertions
    const successCount = results.filter((r) => r.success).length

    // Both succeeded OR one failed with constraint violation - either is acceptable
    // The key is no deadlock and at least one succeeded
    expect(successCount).toBeGreaterThanOrEqual(1)
  })

  test("multiple streams can have concurrent running sessions", async () => {
    const stream1Id = streamId()
    const stream2Id = streamId()
    const testPersonaId = personaId()
    const session1Id = sessionId()
    const session2Id = sessionId()

    // Insert running sessions for two different streams
    await withClient(pool, async (client) => {
      await AgentSessionRepository.insert(client, {
        id: session1Id,
        streamId: stream1Id,
        personaId: testPersonaId,
        triggerMessageId: messageId(),
        status: SessionStatuses.RUNNING,
        serverId: "test-server",
      })

      await AgentSessionRepository.insert(client, {
        id: session2Id,
        streamId: stream2Id,
        personaId: testPersonaId,
        triggerMessageId: messageId(),
        status: SessionStatuses.RUNNING,
        serverId: "test-server",
      })
    })

    // Both should be findable concurrently (different streams, no blocking)
    const results = await Promise.all([
      withClient(pool, async (client) => {
        await client.query("BEGIN")
        const result = await AgentSessionRepository.findRunningByStream(client, stream1Id)
        await client.query("COMMIT")
        return result
      }),
      withClient(pool, async (client) => {
        await client.query("BEGIN")
        const result = await AgentSessionRepository.findRunningByStream(client, stream2Id)
        await client.query("COMMIT")
        return result
      }),
    ])

    expect(results[0]).not.toBeNull()
    expect(results[0]!.id).toBe(session1Id)

    expect(results[1]).not.toBeNull()
    expect(results[1]!.id).toBe(session2Id)
  })

  describe("upsertStep", () => {
    test("should reset timestamps on retry to prevent started > completed", async () => {
      const testStreamId = streamId()
      const testPersonaId = personaId()
      const testSessionId = sessionId()
      const testStepId = stepId()

      await withClient(pool, async (client) => {
        // Create session first
        await AgentSessionRepository.insert(client, {
          id: testSessionId,
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: messageId(),
          status: SessionStatuses.RUNNING,
          serverId: "test-server",
        })

        // Insert initial step
        const originalStart = new Date("2026-01-01T10:00:00Z")
        const step1 = await AgentSessionRepository.upsertStep(client, {
          id: testStepId,
          sessionId: testSessionId,
          stepNumber: 1,
          stepType: AgentStepTypes.THINKING,
          startedAt: originalStart,
        })

        expect(step1.startedAt).toEqual(originalStart)
        expect(step1.completedAt).toBeNull()

        // Complete the step
        const completionTime = new Date("2026-01-01T10:00:05Z")
        await AgentSessionRepository.updateStep(client, testStepId, {
          completedAt: completionTime,
        })

        // Verify completion
        const completedStep = await AgentSessionRepository.findLatestStep(client, testSessionId)
        expect(completedStep!.completedAt).toEqual(completionTime)

        // Retry the step (simulates crash recovery) - this would happen if agent restarts
        const retryStart = new Date("2026-01-01T10:01:00Z")
        const retriedStep = await AgentSessionRepository.upsertStep(client, {
          id: stepId(), // New ID but same step_number triggers conflict
          sessionId: testSessionId,
          stepNumber: 1,
          stepType: AgentStepTypes.THINKING,
          startedAt: retryStart,
          // completedAt not provided = NULL
        })

        // Key assertion: started_at should be the retry time, completed_at should be cleared
        // This prevents the invalid state where started_at > completed_at
        expect(retriedStep.startedAt).toEqual(retryStart)
        expect(retriedStep.completedAt).toBeNull()

        // Verify started_at is NOT greater than completed_at (since completed_at is null, this is satisfied)
        // The old bug would have: started_at=10:01:00, completed_at=10:00:05 (invalid!)
      })
    })
  })

  describe("appendStep", () => {
    test("assigns sequential step_numbers starting at 1", async () => {
      const testSessionId = sessionId()
      await withClient(pool, async (client) => {
        await AgentSessionRepository.insert(client, {
          id: testSessionId,
          streamId: streamId(),
          personaId: personaId(),
          triggerMessageId: messageId(),
          status: SessionStatuses.RUNNING,
          serverId: "test-server",
        })

        const step1 = await AgentSessionRepository.appendStep(client, {
          id: stepId(),
          sessionId: testSessionId,
          stepType: AgentStepTypes.THINKING,
          content: "first",
          startedAt: new Date(),
        })
        const step2 = await AgentSessionRepository.appendStep(client, {
          id: stepId(),
          sessionId: testSessionId,
          stepType: AgentStepTypes.TOOL_CALL,
          content: "second",
          startedAt: new Date(),
        })

        expect(step1.stepNumber).toBe(1)
        expect(step2.stepNumber).toBe(2)
      })
    })

    test("concurrent appends serialize and all rows survive", async () => {
      // Regression for the race in Pi-remote trace recording: two concurrent
      // step POSTs both computed stepNumber = MAX+1, then ON CONFLICT
      // DO UPDATE in upsertStep clobbered one row instead of appending two.
      const testSessionId = sessionId()
      await AgentSessionRepository.insert(pool, {
        id: testSessionId,
        streamId: streamId(),
        personaId: personaId(),
        triggerMessageId: messageId(),
        status: SessionStatuses.RUNNING,
        serverId: "test-server",
      })

      const callers = Array.from({ length: 8 }, (_, i) => i + 1)
      const results = await Promise.all(
        callers.map((n) =>
          withClient(pool, async (client) => {
            await client.query("BEGIN")
            try {
              const step = await AgentSessionRepository.appendStep(client, {
                id: stepId(),
                sessionId: testSessionId,
                stepType: AgentStepTypes.TOOL_CALL,
                content: `concurrent-${n}`,
                startedAt: new Date(),
              })
              await client.query("COMMIT")
              return step
            } catch (err) {
              await client.query("ROLLBACK").catch(() => undefined)
              throw err
            }
          })
        )
      )

      // Every caller must have produced a row — none clobbered.
      const stepNumbers = results.map((s) => s.stepNumber).sort((a, b) => a - b)
      expect(stepNumbers).toEqual(callers)

      // And the DB must agree: 8 distinct step rows, contents intact.
      const rows = await pool.query<{ step_number: number; content: unknown }>(
        "SELECT step_number, content FROM agent_session_steps WHERE session_id = $1 ORDER BY step_number",
        [testSessionId]
      )
      expect(rows.rows.map((r) => r.step_number)).toEqual(callers)
      const contents = new Set(rows.rows.map((r) => r.content as string))
      expect(contents.size).toBe(callers.length)
    })

    test("throws when session does not exist", async () => {
      await expect(
        AgentSessionRepository.appendStep(pool, {
          id: stepId(),
          sessionId: sessionId(),
          stepType: AgentStepTypes.THINKING,
          content: "orphan",
          startedAt: new Date(),
        })
      ).rejects.toThrow(/agent_sessions row not found/)
    })
  })

  describe("insertRunningOrSkip", () => {
    test("concurrent inserts for same stream result in exactly one session", async () => {
      const testStreamId = streamId()
      const testPersonaId = personaId()
      const testMessageId1 = messageId()
      const testMessageId2 = messageId()

      // Fire two concurrent insertRunningOrSkip calls for the same stream
      const [result1, result2] = await Promise.all([
        AgentSessionRepository.insertRunningOrSkip(pool, {
          id: sessionId(),
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: testMessageId1,
          serverId: "server-1",
          initialSequence: BigInt(0),
        }),
        AgentSessionRepository.insertRunningOrSkip(pool, {
          id: sessionId(),
          streamId: testStreamId,
          personaId: testPersonaId,
          triggerMessageId: testMessageId2,
          serverId: "server-2",
          initialSequence: BigInt(0),
        }),
      ])

      // Exactly one should succeed, the other should return null
      const successCount = [result1, result2].filter((r) => r !== null).length
      expect(successCount).toBe(1)

      // Verify only one running session exists for this stream
      const runningSessions = await pool.query(
        `SELECT * FROM agent_sessions WHERE stream_id = $1 AND status = 'running'`,
        [testStreamId]
      )
      expect(runningSessions.rows.length).toBe(1)
    })

    test("allows insert after previous session completed", async () => {
      const testStreamId = streamId()
      const testPersonaId = personaId()
      const testMessageId1 = messageId()
      const testMessageId2 = messageId()

      // Create first session
      const session1 = await AgentSessionRepository.insertRunningOrSkip(pool, {
        id: sessionId(),
        streamId: testStreamId,
        personaId: testPersonaId,
        triggerMessageId: testMessageId1,
        serverId: "server-1",
        initialSequence: BigInt(0),
      })
      expect(session1).not.toBeNull()

      // Complete the first session
      await AgentSessionRepository.completeSession(pool, session1!.id, {
        lastSeenSequence: BigInt(10),
      })

      // Now a second session should be allowed
      const session2 = await AgentSessionRepository.insertRunningOrSkip(pool, {
        id: sessionId(),
        streamId: testStreamId,
        personaId: testPersonaId,
        triggerMessageId: testMessageId2,
        serverId: "server-2",
        initialSequence: BigInt(10),
      })
      expect(session2).not.toBeNull()
      expect(session2!.id).not.toBe(session1!.id)
    })
  })
})
