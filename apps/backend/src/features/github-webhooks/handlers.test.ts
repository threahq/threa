import { describe, expect, mock, test } from "bun:test"
import type { Request, Response } from "express"
import { createGithubWebhookHandlers } from "./handlers"
import { JobQueues, type QueueManager } from "../../lib/queue"

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res as unknown as Response & { statusCode: number; body: unknown }
}

function fakeJobQueue() {
  return { send: mock(async () => "q_1") } as unknown as QueueManager & { send: ReturnType<typeof mock> }
}

const validBody = {
  deliveryGuid: "guid-123",
  eventType: "pull_request",
  action: "opened",
  installationId: "42",
  repositoryFullName: "acme/widgets",
  payload: { pull_request: { number: 1 } },
}

describe("github webhook ingest handler", () => {
  test("enqueues a process job keyed on the delivery guid and returns 200", async () => {
    const jobQueue = fakeJobQueue()
    const handlers = createGithubWebhookHandlers({ jobQueue })
    const res = fakeRes()

    await handlers.ingest({ body: validBody } as Request, res)

    expect(jobQueue.send).toHaveBeenCalledWith(
      JobQueues.GITHUB_WEBHOOK_PROCESS,
      { workspaceId: "system", ...validBody },
      { messageId: "ghwh_guid-123" }
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  test("rejects a body that does not match the wire shape", async () => {
    const jobQueue = fakeJobQueue()
    const handlers = createGithubWebhookHandlers({ jobQueue })

    await expect(handlers.ingest({ body: { eventType: "pull_request" } } as Request, fakeRes())).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    })
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  test("accepts null action/installation/repository (wire shape allows null)", async () => {
    const jobQueue = fakeJobQueue()
    const handlers = createGithubWebhookHandlers({ jobQueue })
    const res = fakeRes()

    await handlers.ingest(
      {
        body: {
          deliveryGuid: "guid-9",
          eventType: "installation",
          action: null,
          installationId: null,
          repositoryFullName: null,
          payload: {},
        },
      } as Request,
      res
    )

    expect(res.statusCode).toBe(200)
    expect(jobQueue.send).toHaveBeenCalledTimes(1)
  })
})
