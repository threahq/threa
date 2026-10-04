import { describe, expect, it, mock, afterEach } from "bun:test"
import { createSavedReminderWorker } from "./worker"
import type { SavedMessagesService } from "./service"
import type { Job, SavedReminderFireJobData } from "../../lib/queue"

function fakeJob(data: SavedReminderFireJobData): Job<SavedReminderFireJobData> {
  return {
    id: "remq_01",
    queueName: "saved.reminder_fire",
    data,
    insertedAt: new Date(),
    failedCount: 0,
  } as unknown as Job<SavedReminderFireJobData>
}

describe("createSavedReminderWorker", () => {
  afterEach(() => mock.restore())

  it("delegates to markReminderFired with the workspace, user and saved id from the job", async () => {
    const markReminderFired = mock(async () => ({ fired: true }))
    const worker = createSavedReminderWorker({
      savedMessagesService: { markReminderFired } as unknown as SavedMessagesService,
    })

    await worker(fakeJob({ workspaceId: "ws_1", userId: "usr_1", savedMessageId: "saved_01" }))

    expect(markReminderFired).toHaveBeenCalledWith({ workspaceId: "ws_1", userId: "usr_1", savedId: "saved_01" })
  })

  it("no-ops quietly when the service reports fired=false (done/archived/already-fired)", async () => {
    const markReminderFired = mock(async () => ({ fired: false }))
    const worker = createSavedReminderWorker({
      savedMessagesService: { markReminderFired } as unknown as SavedMessagesService,
    })

    await expect(
      worker(fakeJob({ workspaceId: "ws_1", userId: "usr_1", savedMessageId: "saved_01" }))
    ).resolves.toBeUndefined()
    expect(markReminderFired).toHaveBeenCalledTimes(1)
  })

  it("propagates service errors so the queue retries", async () => {
    const markReminderFired = mock(async () => {
      throw new Error("db down")
    })
    const worker = createSavedReminderWorker({
      savedMessagesService: { markReminderFired } as unknown as SavedMessagesService,
    })

    await expect(worker(fakeJob({ workspaceId: "ws_1", userId: "usr_1", savedMessageId: "saved_01" }))).rejects.toThrow(
      "db down"
    )
  })
})
