import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { AuthorTypes, CompanionModes, SavedStatuses, StreamTypes, Visibilities } from "@threa/types"
import { SavedMessagesService } from "./service"
import { SavedMessagesRepository } from "./repository"
// Streams before messaging to avoid a latent circular-init in public-api/schemas.ts.
import { StreamRepository, StreamMemberRepository } from "../streams"
import { MessageRepository } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { QueueRepository } from "../../lib/queue"
import * as dbModule from "../../db"
import * as viewModule from "./view"
import type { Stream } from "../streams"
import type { Message } from "../messaging"
import type { SavedMessage } from "./repository"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"
const MESSAGE_ID = "msg_1"
const STREAM_ID = "stream_1"
const SAVED_ID = "saved_01"
const NOW = new Date("2026-04-16T12:00:00.000Z")
// `FUTURE` must be in the test runtime's real future so clampRemindAt doesn't
// rewrite it to `Date.now()`; dates in 2099 comfortably outlive any clock.
const FUTURE = new Date("2099-01-01T00:00:00.000Z")

function fakeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    type: StreamTypes.CHANNEL,
    displayName: "General",
    slug: "general",
    description: null,
    visibility: Visibilities.PUBLIC,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: CompanionModes.OFF,
    companionPersonaId: null,
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: MESSAGE_ID,
    streamId: STREAM_ID,
    sequence: 1n,
    authorId: "usr_author",
    authorType: AuthorTypes.USER,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: NOW,
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    ...overrides,
  }
}

function fakeSaved(overrides: Partial<SavedMessage> = {}): SavedMessage {
  return {
    id: SAVED_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    messageId: MESSAGE_ID,
    streamId: STREAM_ID,
    status: SavedStatuses.SAVED,
    title: null,
    note: null,
    remindAt: null,
    reminderSentAt: null,
    reminderQueueMessageId: null,
    savedAt: NOW,
    statusChangedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function setupService() {
  // withTransaction invokes the callback with a fake client
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  // resolveSavedView is covered by its own tests; stub out here
  spyOn(viewModule, "resolveSavedView").mockImplementation(async (_db: any, _userId: string, rows: SavedMessage[]) =>
    rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      userId: r.userId,
      messageId: r.messageId,
      streamId: r.streamId,
      status: r.status,
      title: r.title,
      note: r.note,
      remindAt: r.remindAt?.toISOString() ?? null,
      reminderSentAt: r.reminderSentAt?.toISOString() ?? null,
      savedAt: r.savedAt.toISOString(),
      statusChangedAt: r.statusChangedAt.toISOString(),
      message: null,
      unavailableReason: null,
    }))
  )
  return new SavedMessagesService({ pool: {} as any })
}

describe("SavedMessagesService.save", () => {
  afterEach(() => mock.restore())

  it("throws 404 when the message is missing or deleted", async () => {
    const service = setupService()
    spyOn(MessageRepository, "findById").mockResolvedValue(null)

    await expect(
      service.save({ workspaceId: WORKSPACE_ID, userId: USER_ID, messageId: MESSAGE_ID, remindAt: null })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("throws 404 when the message's stream is not in the caller's workspace", async () => {
    const service = setupService()
    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage())
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream({ workspaceId: "ws_other" }))

    await expect(
      service.save({ workspaceId: WORKSPACE_ID, userId: USER_ID, messageId: MESSAGE_ID, remindAt: null })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("throws 403 on private streams when the user is not a member", async () => {
    const service = setupService()
    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage())
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream({ visibility: Visibilities.PRIVATE }))
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    await expect(
      service.save({ workspaceId: WORKSPACE_ID, userId: USER_ID, messageId: MESSAGE_ID, remindAt: null })
    ).rejects.toMatchObject({ status: 403 })
  })

  it("clamps past remindAt values to NOW() so reminders in the past fire immediately", async () => {
    const service = setupService()
    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage())
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())

    let capturedRemindAt: Date | null = null
    spyOn(SavedMessagesRepository, "upsert").mockImplementation(async (_db: any, params: any) => {
      capturedRemindAt = params.remindAt
      return { saved: fakeSaved({ remindAt: params.remindAt }), inserted: true, previousReminderQueueMessageId: null }
    })
    spyOn(SavedMessagesRepository, "updateReminder").mockResolvedValue(fakeSaved())
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(QueueRepository, "insert").mockResolvedValue({} as any)

    const past = new Date(Date.now() - 60_000)
    await service.save({ workspaceId: WORKSPACE_ID, userId: USER_ID, messageId: MESSAGE_ID, remindAt: past })

    expect(capturedRemindAt).not.toBeNull()
    expect(capturedRemindAt!.getTime()).toBeGreaterThanOrEqual(past.getTime())
    // Should have been clamped forward to approximately now
    expect(capturedRemindAt!.getTime()).toBeGreaterThan(past.getTime() + 30_000)
  })

  it("emits saved:upserted outbox event with the live-resolved view", async () => {
    const service = setupService()
    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage())
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    spyOn(SavedMessagesRepository, "upsert").mockResolvedValue({
      saved: fakeSaved(),
      inserted: true,
      previousReminderQueueMessageId: null,
    })

    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.save({ workspaceId: WORKSPACE_ID, userId: USER_ID, messageId: MESSAGE_ID, remindAt: null })

    expect(outboxSpy).toHaveBeenCalledTimes(1)
    const [, eventType, payload] = outboxSpy.mock.calls[0]!
    expect(eventType).toBe("saved:upserted")
    expect(payload).toMatchObject({
      workspaceId: WORKSPACE_ID,
      targetUserId: USER_ID,
      saved: expect.objectContaining({ id: SAVED_ID, status: SavedStatuses.SAVED }),
    })
  })
})

describe("SavedMessagesService.createStandalone", () => {
  afterEach(() => mock.restore())

  it("inserts a message-less row without any message/stream access checks", async () => {
    const service = setupService()
    const findMessageSpy = spyOn(MessageRepository, "findById")
    const insertSpy = spyOn(SavedMessagesRepository, "insertStandalone").mockResolvedValue(
      fakeSaved({ messageId: null, streamId: null, title: "Call the landlord", note: "About the lease" })
    )
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const view = await service.createStandalone({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      title: "Call the landlord",
      note: "About the lease",
      remindAt: null,
    })

    expect(findMessageSpy).not.toHaveBeenCalled()
    expect(insertSpy.mock.calls[0]![1]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      title: "Call the landlord",
      note: "About the lease",
    })
    expect(view).toMatchObject({ messageId: null, streamId: null, title: "Call the landlord" })
    const [, eventType, payload] = outboxSpy.mock.calls[0]!
    expect(eventType).toBe("saved:upserted")
    expect(payload).toMatchObject({ workspaceId: WORKSPACE_ID, targetUserId: USER_ID })
  })

  it("enqueues a reminder when remindAt is provided", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "insertStandalone").mockResolvedValue(
      fakeSaved({ messageId: null, streamId: null, title: "Standup prep", remindAt: FUTURE })
    )
    const updateReminderSpy = spyOn(SavedMessagesRepository, "updateReminder").mockResolvedValue(
      fakeSaved({ messageId: null, streamId: null, title: "Standup prep", remindAt: FUTURE })
    )
    spyOn(QueueRepository, "insert").mockResolvedValue({} as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.createStandalone({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      title: "Standup prep",
      note: null,
      remindAt: FUTURE,
    })

    // The queue row id is pinned back onto the saved row inside the same tx
    expect(updateReminderSpy).toHaveBeenCalled()
    expect(updateReminderSpy.mock.calls[0]![4]).toMatchObject({ remindAt: FUTURE })
  })
})

describe("SavedMessagesService.updateContent", () => {
  afterEach(() => mock.restore())

  it("throws 404 when the row does not exist", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "updateContent").mockResolvedValue(null)

    await expect(
      service.updateContent({ workspaceId: WORKSPACE_ID, userId: USER_ID, savedId: SAVED_ID, note: "x" })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("updates note on a message-anchored row and emits saved:upserted", async () => {
    const service = setupService()
    const updateSpy = spyOn(SavedMessagesRepository, "updateContent").mockResolvedValue(
      fakeSaved({ note: "deadline moved to Friday" })
    )
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const view = await service.updateContent({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      savedId: SAVED_ID,
      note: "deadline moved to Friday",
    })

    expect(updateSpy.mock.calls[0]![4]).toEqual({ title: undefined, note: "deadline moved to Friday" })
    expect(view.note).toBe("deadline moved to Friday")
    expect(outboxSpy.mock.calls[0]![1]).toBe("saved:upserted")
  })
})

describe("SavedMessagesService.updateStatus", () => {
  afterEach(() => mock.restore())

  it("throws 404 when the row does not exist", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findById").mockResolvedValue(null)

    await expect(
      service.updateStatus({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        savedId: SAVED_ID,
        status: SavedStatuses.DONE,
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("emits saved:upserted after a successful status change", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findById").mockResolvedValue(fakeSaved())
    spyOn(SavedMessagesRepository, "updateStatus").mockResolvedValue(
      fakeSaved({ status: SavedStatuses.DONE, statusChangedAt: FUTURE })
    )
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.updateStatus({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      savedId: SAVED_ID,
      status: SavedStatuses.DONE,
    })

    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "saved:upserted",
      expect.objectContaining({ saved: expect.objectContaining({ status: SavedStatuses.DONE }) })
    )
  })
})

describe("SavedMessagesService.updateReminder", () => {
  afterEach(() => mock.restore())

  it("rejects setting a reminder on non-saved rows with 409", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findById").mockResolvedValue(fakeSaved({ status: SavedStatuses.DONE }))

    await expect(
      service.updateReminder({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        savedId: SAVED_ID,
        remindAt: FUTURE,
      })
    ).rejects.toMatchObject({ status: 409 })
  })

  it("clamps a past remindAt to NOW() and persists it", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findById").mockResolvedValue(fakeSaved())

    let capturedRemindAt: Date | null = null
    spyOn(SavedMessagesRepository, "updateReminder").mockImplementation(
      async (_db: any, _ws: any, _u: any, _id: any, p: any) => {
        capturedRemindAt = p.remindAt
        return fakeSaved({ remindAt: p.remindAt })
      }
    )
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(QueueRepository, "insert").mockResolvedValue({} as any)
    spyOn(QueueRepository, "cancelById").mockResolvedValue(true)

    const past = new Date(Date.now() - 60_000)
    await service.updateReminder({ workspaceId: WORKSPACE_ID, userId: USER_ID, savedId: SAVED_ID, remindAt: past })

    expect(capturedRemindAt).not.toBeNull()
    expect(capturedRemindAt!.getTime()).toBeGreaterThan(past.getTime() + 30_000)
  })
})

describe("SavedMessagesService.delete", () => {
  afterEach(() => mock.restore())

  it("emits saved:deleted when a row is removed", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findById").mockResolvedValue(fakeSaved())
    spyOn(SavedMessagesRepository, "delete").mockResolvedValue(true)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.delete({ workspaceId: WORKSPACE_ID, userId: USER_ID, savedId: SAVED_ID })

    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "saved:deleted",
      expect.objectContaining({ savedId: SAVED_ID, messageId: MESSAGE_ID })
    )
  })

  it("throws 404 when the row is missing", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findById").mockResolvedValue(null)

    await expect(
      service.delete({ workspaceId: WORKSPACE_ID, userId: USER_ID, savedId: SAVED_ID })
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("SavedMessagesService reminder queue integration", () => {
  afterEach(() => mock.restore())

  it("save with remindAt cancels the previous queue row and enqueues a fresh one", async () => {
    const service = setupService()
    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage())
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    spyOn(SavedMessagesRepository, "upsert").mockResolvedValue({
      saved: fakeSaved({ remindAt: FUTURE }),
      inserted: false,
      previousReminderQueueMessageId: "remq_old",
    })
    spyOn(SavedMessagesRepository, "updateReminder").mockResolvedValue(fakeSaved({ remindAt: FUTURE }))
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const cancelSpy = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)
    const insertSpy = spyOn(QueueRepository, "insert").mockResolvedValue({} as any)

    await service.save({ workspaceId: WORKSPACE_ID, userId: USER_ID, messageId: MESSAGE_ID, remindAt: FUTURE })

    expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "remq_old")
    expect(insertSpy).toHaveBeenCalledTimes(1)
    const [, insertParams] = insertSpy.mock.calls[0]!
    expect(insertParams).toMatchObject({ queueName: "saved.reminder_fire" })
    expect(insertParams.processAfter).toEqual(FUTURE)
  })

  it("save without remindAt does not enqueue a reminder", async () => {
    const service = setupService()
    spyOn(MessageRepository, "findById").mockResolvedValue(fakeMessage())
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    spyOn(SavedMessagesRepository, "upsert").mockResolvedValue({
      saved: fakeSaved(),
      inserted: true,
      previousReminderQueueMessageId: null,
    })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const insertSpy = spyOn(QueueRepository, "insert").mockResolvedValue({} as any)
    const cancelSpy = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)

    await service.save({ workspaceId: WORKSPACE_ID, userId: USER_ID, messageId: MESSAGE_ID, remindAt: null })

    expect(insertSpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it("markDone cancels a pending reminder when one exists", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findById").mockResolvedValue(fakeSaved({ reminderQueueMessageId: "remq_pending" }))
    spyOn(SavedMessagesRepository, "updateStatus").mockResolvedValue(
      fakeSaved({ status: SavedStatuses.DONE, statusChangedAt: FUTURE })
    )
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const cancelSpy = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)

    await service.updateStatus({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      savedId: SAVED_ID,
      status: SavedStatuses.DONE,
    })

    expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "remq_pending")
  })

  it("delete cancels a pending reminder before removing the row", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findById").mockResolvedValue(fakeSaved({ reminderQueueMessageId: "remq_pending" }))
    spyOn(SavedMessagesRepository, "delete").mockResolvedValue(true)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    const cancelSpy = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)

    await service.delete({ workspaceId: WORKSPACE_ID, userId: USER_ID, savedId: SAVED_ID })

    expect(cancelSpy).toHaveBeenCalledWith(expect.anything(), "remq_pending")
  })
})

describe("SavedMessagesService.markReminderFired", () => {
  afterEach(() => mock.restore())

  it("no-ops when the row is missing", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findByIdUnscoped").mockResolvedValue(null)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.markReminderFired({ savedId: SAVED_ID })

    expect(result.fired).toBe(false)
    expect(outboxSpy).not.toHaveBeenCalled()
  })

  it("no-ops when status is no longer 'saved'", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findByIdUnscoped").mockResolvedValue(fakeSaved({ status: SavedStatuses.DONE }))
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.markReminderFired({ savedId: SAVED_ID })

    expect(result.fired).toBe(false)
    expect(outboxSpy).not.toHaveBeenCalled()
  })

  it("no-ops when reminder already sent", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findByIdUnscoped").mockResolvedValue(fakeSaved({ reminderSentAt: NOW }))
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.markReminderFired({ savedId: SAVED_ID })

    expect(result.fired).toBe(false)
    expect(outboxSpy).not.toHaveBeenCalled()
  })

  it("emits saved_reminder:fired when the row is still pending", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findByIdUnscoped").mockResolvedValue(fakeSaved())
    spyOn(SavedMessagesRepository, "markReminderSent").mockResolvedValue(fakeSaved({ reminderSentAt: NOW }))
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.markReminderFired({ savedId: SAVED_ID })

    expect(result.fired).toBe(true)
    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "saved_reminder:fired",
      expect.objectContaining({
        savedId: SAVED_ID,
        messageId: MESSAGE_ID,
        streamId: STREAM_ID,
      })
    )
  })

  it("no-ops when markReminderSent returns null (race with another worker)", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "findByIdUnscoped").mockResolvedValue(fakeSaved())
    spyOn(SavedMessagesRepository, "markReminderSent").mockResolvedValue(null)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.markReminderFired({ savedId: SAVED_ID })

    expect(result.fired).toBe(false)
    expect(outboxSpy).not.toHaveBeenCalled()
  })
})

describe("SavedMessagesService.list", () => {
  afterEach(() => mock.restore())

  it("requests limit+1 rows and sets nextCursor when there are more", async () => {
    const service = setupService()
    // return 3 rows; limit is 2, so we expect a nextCursor
    spyOn(SavedMessagesRepository, "listByUser").mockResolvedValue([
      fakeSaved({ id: "saved_a" }),
      fakeSaved({ id: "saved_b" }),
      fakeSaved({ id: "saved_c" }),
    ])

    const result = await service.list({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      status: SavedStatuses.SAVED,
      limit: 2,
    })

    expect(result.saved).toHaveLength(2)
    expect(result.nextCursor).toBe("saved_b")
  })

  it("returns nextCursor=null when the page is not full", async () => {
    const service = setupService()
    spyOn(SavedMessagesRepository, "listByUser").mockResolvedValue([fakeSaved()])

    const result = await service.list({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      status: SavedStatuses.SAVED,
      limit: 50,
    })

    expect(result.saved).toHaveLength(1)
    expect(result.nextCursor).toBeNull()
  })
})
