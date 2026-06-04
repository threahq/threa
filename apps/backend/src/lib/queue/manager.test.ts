import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { QueueManager } from "./manager"
import { logger } from "../logger"
import { registry } from "../observability"

function createManager(queueInsert: (...args: any[]) => Promise<unknown>) {
  return new QueueManager({
    pool: {} as any,
    queueRepository: {
      insert: queueInsert,
    } as any,
    tokenPoolRepository: {} as any,
  })
}

afterEach(() => {
  registry.resetMetrics()
})

describe("QueueManager.send", () => {
  it("returns the provided message ID when duplicate idempotent send races", async () => {
    const duplicateError = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "queue_messages_pkey",
    })
    const insert = mock(async () => {
      throw duplicateError
    })
    const manager = createManager(insert)

    const messageId = await manager.send(
      "persona.agent" as any,
      {
        workspaceId: "ws_1",
      } as any,
      {
        messageId: "queue_rerun_session_1",
      }
    )

    expect(messageId).toBe("queue_rerun_session_1")
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it("rethrows duplicate key errors when no idempotency message ID is provided", async () => {
    const duplicateError = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "queue_messages_pkey",
    })
    const insert = mock(async () => {
      throw duplicateError
    })
    const manager = createManager(insert)

    await expect(
      manager.send(
        "persona.agent" as any,
        {
          workspaceId: "ws_1",
        } as any
      )
    ).rejects.toThrow("duplicate")
  })
})

describe("QueueManager stuck token warning", () => {
  it("warns and records a metric when a token exceeds the stuck threshold", async () => {
    let releaseHandler: () => void = () => {}
    const blockedHandler = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })

    const handler = mock(async () => {
      await blockedHandler
    })
    const warnSpy = spyOn(logger, "warn")
    const deleteToken = mock(async () => {})

    const manager = new QueueManager({
      pool: {} as any,
      queueRepository: {
        batchClaimMessages: mock(async () => [
          {
            id: "queue_msg_1",
            queueName: "persona.agent",
            workspaceId: "ws_1",
            payload: { workspaceId: "ws_1" },
            failedCount: 0,
            insertedAt: new Date(),
          },
        ]),
        batchRenewClaims: mock(async () => 1),
        complete: mock(async () => {}),
      } as any,
      tokenPoolRepository: {
        renewLease: mock(async () => true),
        deleteToken,
      } as any,
      stuckTokenWarnMs: 20,
      refreshIntervalMs: 1000,
    })

    manager.registerHandler("persona.agent" as any, handler as any)

    const tokenPromise = (manager as any).processToken({
      id: "token_1",
      queueName: "persona.agent",
      workspaceId: "ws_1",
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 50))

      const metricsOutput = await registry.metrics()
      expect(metricsOutput).toContain('queue_tokens_stuck_total{queue="persona.agent",workspace_id="ws_1"} 1')

      const stuckWarning = warnSpy.mock.calls.find((call) => call[1] === "Queue token exceeded stuck warning threshold")
      expect(stuckWarning).toBeDefined()
    } finally {
      releaseHandler()
      await tokenPromise
      warnSpy.mockRestore()
    }

    expect(deleteToken).toHaveBeenCalledTimes(1)
  })
})

describe("QueueManager per-queue maxRetries override", () => {
  function createFailureManager() {
    const fail = mock(async () => {})
    const failDlq = mock(async () => {})
    const manager = new QueueManager({
      pool: {} as any,
      queueRepository: { fail, failDlq } as any,
      tokenPoolRepository: {} as any,
      // Manager-wide default budget.
      maxRetries: 5,
    })
    return { manager, fail, failDlq }
  }

  const failingHandler = mock(async () => {
    throw new Error("park me")
  })

  it("keeps retrying past the manager default when the queue declares a larger budget", async () => {
    const { manager, fail, failDlq } = createFailureManager()
    manager.registerHandler("enclave.invoke" as any, failingHandler as any, { maxRetries: 10 })

    // failedCount 5 would DLQ under the default (6 >= 5) but must retry under 10.
    await (manager as any).processMessage(
      {
        id: "qm_1",
        queueName: "enclave.invoke",
        workspaceId: "ws_1",
        payload: {},
        failedCount: 5,
        insertedAt: new Date(),
      },
      "worker_1",
      new Set<string>()
    )

    expect(fail).toHaveBeenCalledTimes(1)
    expect(failDlq).not.toHaveBeenCalled()
  })

  it("falls back to the manager default for queues without an override", async () => {
    const { manager, fail, failDlq } = createFailureManager()
    manager.registerHandler("persona.agent" as any, failingHandler as any)

    await (manager as any).processMessage(
      {
        id: "qm_2",
        queueName: "persona.agent",
        workspaceId: "ws_1",
        payload: {},
        failedCount: 5,
        insertedAt: new Date(),
      },
      "worker_1",
      new Set<string>()
    )

    expect(failDlq).toHaveBeenCalledTimes(1)
    expect(fail).not.toHaveBeenCalled()
  })
})
