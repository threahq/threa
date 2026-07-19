import { describe, it, expect, beforeEach, vi } from "vitest"
import { db, type CachedScheduledMessage } from "@/db"
import { ApiError } from "@/api"
import { enqueueOperation, processOperationQueue } from "./operation-queue"

const workspaceId = "ws_1"
const schedId = "sched_01TESTROW00000000000000000"

function cachedScheduledRow(overrides: Partial<CachedScheduledMessage> = {}): CachedScheduledMessage {
  return {
    id: schedId,
    workspaceId,
    userId: "usr_1",
    streamId: "stream_1",
    parentMessageId: null,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
    attachmentIds: [],
    metadata: null,
    scheduledFor: "2026-07-19T12:00:00.000Z",
    status: "pending",
    sentMessageId: null,
    lastError: null,
    editActiveUntil: null,
    clientMessageId: null,
    version: 1,
    createdAt: "2026-07-19T11:00:00.000Z",
    updatedAt: "2026-07-19T11:00:00.000Z",
    statusChangedAt: "2026-07-19T11:00:00.000Z",
    _scheduledForMs: Date.parse("2026-07-19T12:00:00.000Z"),
    _statusChangedAtMs: Date.parse("2026-07-19T11:00:00.000Z"),
    _cachedAt: Date.parse("2026-07-19T11:00:00.000Z"),
    ...overrides,
  }
}

const messageService = {
  update: vi.fn(),
  delete: vi.fn(),
}
const reactionService = {
  add: vi.fn(),
  remove: vi.fn(),
}

function scheduledServiceRejectingWith(error: unknown) {
  return {
    create: vi.fn().mockRejectedValue(error),
    delete: vi.fn().mockRejectedValue(error),
    sendNow: vi.fn().mockRejectedValue(error),
  }
}

async function process(scheduledService: ReturnType<typeof scheduledServiceRejectingWith>) {
  await processOperationQueue(messageService, reactionService, scheduledService, undefined, () => true)
}

beforeEach(async () => {
  vi.clearAllMocks()
  await db.pendingOperations.clear()
  await db.scheduledMessages.clear()
})

describe("processOperationQueue permanent-4xx handling", () => {
  // The prod 2026-07-19 send-now loop: 11 IDB ops replaying a 409 on every
  // queue kick, forever. A permanent 4xx must kill the op AND the stale row
  // that keeps inviting the user to re-tap.
  it("drops a send_scheduled_now op on 409 and evicts the stale local row", async () => {
    await db.scheduledMessages.put(cachedScheduledRow())
    await enqueueOperation(workspaceId, "send_scheduled_now", { id: schedId })

    const scheduledService = scheduledServiceRejectingWith(
      new ApiError(409, "SCHEDULED_MESSAGE_ALREADY_SENT", "Already sent")
    )
    await process(scheduledService)

    expect(await db.pendingOperations.toArray()).toEqual([])
    expect(await db.scheduledMessages.get(schedId)).toBeUndefined()

    // A later kick must not replay the dropped op.
    await process(scheduledService)
    expect(scheduledService.sendNow).toHaveBeenCalledTimes(1)
  })

  it("drops a cancel_scheduled_message op on 404 and evicts the stale local row", async () => {
    await db.scheduledMessages.put(cachedScheduledRow())
    await enqueueOperation(workspaceId, "cancel_scheduled_message", { id: schedId })

    await process(scheduledServiceRejectingWith(new ApiError(404, "SCHEDULED_MESSAGE_NOT_FOUND", "Not found")))

    expect(await db.pendingOperations.toArray()).toEqual([])
    expect(await db.scheduledMessages.get(schedId)).toBeUndefined()
  })

  it("retains the op for retry on a network error", async () => {
    await enqueueOperation(workspaceId, "send_scheduled_now", { id: schedId })

    await process(scheduledServiceRejectingWith(new TypeError("Failed to fetch")))

    const [op] = await db.pendingOperations.toArray()
    expect(op).toMatchObject({ type: "send_scheduled_now", retryCount: 1 })
  })

  it("retains the op for retry on 429", async () => {
    await enqueueOperation(workspaceId, "send_scheduled_now", { id: schedId })

    await process(scheduledServiceRejectingWith(new ApiError(429, "RATE_LIMITED", "Slow down")))

    const [op] = await db.pendingOperations.toArray()
    expect(op).toMatchObject({ type: "send_scheduled_now", retryCount: 1 })
  })
})
