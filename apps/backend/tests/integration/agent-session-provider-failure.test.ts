import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { APICallError, RetryError } from "ai"
import type { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { AgentSessionRepository, withCompanionSession, type AgentSession } from "../../src/features/agents"
import { messageId, personaId, streamId, workspaceId } from "../../src/lib/id"

const SONNET = "openrouter:anthropic/claude-sonnet-4.6"
const HAIKU = "openrouter:anthropic/claude-haiku-5.5"

function providerError(isRetryable: boolean): APICallError {
  return new APICallError({
    message: "provider unavailable",
    url: "https://provider.example/v1/chat",
    requestBodyValues: {},
    statusCode: isRetryable ? 503 : 400,
    isRetryable,
  })
}

describe("a session attempt that fails on a model provider", () => {
  const testWorkspaceId = workspaceId()
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  /** One queue job's attempts of the same session: same trigger, stream and persona each time. */
  function sessionAttempts() {
    const ids = { triggerMessageId: messageId(), streamId: streamId(), personaId: personaId() }
    return (attempt: number, run: (session: AgentSession, reportTurnModel: (model: string) => void) => never) => {
      let received: AgentSession | null = null
      const result = withCompanionSession(
        {
          pool,
          ...ids,
          personaName: "Ariadne",
          workspaceId: testWorkspaceId,
          serverId: "test-server",
          initialSequence: 1n,
          attempt,
          maxAttempts: 5,
        },
        async (session, _db, reportTurnModel) => {
          received = session
          return run(session, reportTurnModel)
        }
      )
      return result.then((outcome) => ({ outcome, received: received as AgentSession | null }))
    }
  }

  async function recordedModel(sessionId: string): Promise<string | null | undefined> {
    return (await AgentSessionRepository.findById(pool, testWorkspaceId, sessionId))?.providerFailedModel
  }

  test("should record the failed model, hand it to the next attempt, and clear it on a non-provider failure", async () => {
    const attempt = sessionAttempts()

    const first = await attempt(0, (_session, report) => {
      report(SONNET)
      throw providerError(true)
    })
    expect(first.outcome).toMatchObject({ status: "failed", willRetry: true, retryable: true })
    expect(first.received?.providerFailedModel).toBeNull()
    expect(await recordedModel(first.outcome.sessionId!)).toBe(SONNET)

    const second = await attempt(1, (_session, report) => {
      report(HAIKU)
      throw new Error("tool exploded")
    })
    expect(second.received).toMatchObject({ id: first.outcome.sessionId, providerFailedModel: SONNET })
    expect(second.outcome).toMatchObject({ status: "failed", willRetry: true, retryable: true })
    expect(await recordedModel(first.outcome.sessionId!)).toBeNull()

    const third = await attempt(2, () => {
      throw new Error("again")
    })
    expect(third.received?.providerFailedModel).toBeNull()
  })

  test("should give a non-retryable provider failure one more attempt, then be terminal", async () => {
    const attempt = sessionAttempts()

    const first = await attempt(0, (_session, report) => {
      report(SONNET)
      throw providerError(false)
    })
    expect(first.outcome).toMatchObject({ status: "failed", willRetry: true, retryable: true })
    expect(await recordedModel(first.outcome.sessionId!)).toBe(SONNET)

    const second = await attempt(1, (_session, report) => {
      report(HAIKU)
      throw providerError(false)
    })
    expect(second.received?.providerFailedModel).toBe(SONNET)
    expect(second.outcome).toMatchObject({ status: "failed", willRetry: false, retryable: false })
    expect(await recordedModel(first.outcome.sessionId!)).toBe(HAIKU)
  })

  test("should count a RetryError whose last error is a provider error", async () => {
    const attempt = sessionAttempts()

    const first = await attempt(0, (_session, report) => {
      report(SONNET)
      throw new RetryError({
        message: "Failed after 2 attempts",
        reason: "maxRetriesExceeded",
        errors: [providerError(true), providerError(true)],
      })
    })
    expect(first.outcome).toMatchObject({ status: "failed", willRetry: true, retryable: true })
    expect(await recordedModel(first.outcome.sessionId!)).toBe(SONNET)
  })

  test("should keep retrying, as before, a RetryError that ends on a non-retryable provider error", async () => {
    const attempt = sessionAttempts()

    const first = await attempt(0, () => {
      throw new RetryError({
        message: "Failed after 2 attempts",
        reason: "errorNotRetryable",
        errors: [providerError(true), providerError(false)],
      })
    })
    expect(first.outcome).toMatchObject({ status: "failed", willRetry: true, retryable: true })
    expect(await recordedModel(first.outcome.sessionId!)).toBeNull()
  })

  test("should stay terminal as before when the attempt failed before naming its model", async () => {
    const attempt = sessionAttempts()

    const first = await attempt(0, () => {
      throw providerError(false)
    })
    expect(first.outcome).toMatchObject({ status: "failed", willRetry: false, retryable: false })
    expect(await recordedModel(first.outcome.sessionId!)).toBeNull()
  })
})
