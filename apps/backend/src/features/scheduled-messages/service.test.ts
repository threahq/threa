import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { CompanionModes, ScheduledMessageStatuses, StreamTypes, Visibilities } from "@threa/types"
import { ScheduledMessagesService } from "./service"
import { ScheduledMessagesRepository, type ScheduledMessage } from "./repository"
import { StreamRepository, StreamMemberRepository } from "../streams"
import type { EventService } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { QueueRepository } from "../../lib/queue"
import * as dbModule from "../../db"
import type { Stream } from "../streams"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"
const STREAM_ID = "stream_1"
const SCHEDULED_ID = "sched_01"
const NOW = new Date("2026-05-03T12:00:00.000Z")
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

function fakeScheduled(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: SCHEDULED_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    streamId: STREAM_ID,
    parentMessageId: null,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
    attachmentIds: [],
    metadata: null,
    scheduledFor: FUTURE,
    status: ScheduledMessageStatuses.PENDING,
    sentMessageId: null,
    lastError: null,
    queueMessageId: null,
    editActiveUntil: null,
    clientMessageId: null,
    retryCount: 0,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

const fakeEventService = (override: Partial<EventService> = {}): EventService =>
  ({
    createMessage: mock(async () => ({
      id: "msg_42",
      streamId: STREAM_ID,
      sequence: 1n,
      authorId: USER_ID,
      authorType: "user" as const,
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
    })),
    ...override,
  }) as unknown as EventService

function setupService(eventService: EventService = fakeEventService()) {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  return new ScheduledMessagesService({ pool: {} as any, eventService })
}

describe("ScheduledMessagesService.schedule", () => {
  afterEach(() => mock.restore())

  it("rejects when the stream isn't in the caller's workspace (workspace-scope guard)", async () => {
    const service = setupService()
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream({ workspaceId: "ws_other" }))

    await expect(
      service.schedule({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        streamId: STREAM_ID,
        parentMessageId: null,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "x",
        attachmentIds: [],
        metadata: null,
        scheduledFor: FUTURE,
        clientMessageId: null,
      })
    ).rejects.toThrow(/not found/i)
  })

  it("refuses to schedule into an E2E stream (server can't seal at fire time) — E2EE-3", async () => {
    const service = setupService()
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream({ e2eEnabled: true }))
    const insertSpy = spyOn(ScheduledMessagesRepository, "insert")

    await expect(
      service.schedule({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        streamId: STREAM_ID,
        parentMessageId: null,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "x",
        attachmentIds: [],
        metadata: null,
        scheduledFor: FUTURE,
        clientMessageId: null,
      })
    ).rejects.toMatchObject({ status: 400, code: "E2E_STREAM_SCHEDULING_UNSUPPORTED" })
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("requires stream membership for private streams", async () => {
    const service = setupService()
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream({ visibility: Visibilities.PRIVATE }))
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    await expect(
      service.schedule({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        streamId: STREAM_ID,
        parentMessageId: null,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "x",
        attachmentIds: [],
        metadata: null,
        scheduledFor: FUTURE,
        clientMessageId: null,
      })
    ).rejects.toThrow(/member/i)
  })

  it("returns the existing row when the same clientMessageId was already scheduled (idempotent)", async () => {
    const service = setupService()
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    const existing = fakeScheduled({ clientMessageId: "cli_1" })
    spyOn(ScheduledMessagesRepository, "findByClientMessageId").mockResolvedValue(existing)
    const insertSpy = spyOn(ScheduledMessagesRepository, "insert").mockResolvedValue(existing)

    const result = await service.schedule({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      streamId: STREAM_ID,
      parentMessageId: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "x",
      attachmentIds: [],
      metadata: null,
      scheduledFor: FUTURE,
      clientMessageId: "cli_1",
    })

    expect(result.id).toBe(SCHEDULED_ID)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("inserts the row, enqueues the fire job, and emits scheduled_message:upserted in the same tx", async () => {
    const service = setupService()
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    const inserted = fakeScheduled()
    spyOn(ScheduledMessagesRepository, "findByClientMessageId").mockResolvedValue(null)
    spyOn(ScheduledMessagesRepository, "insert").mockResolvedValue(inserted)
    spyOn(ScheduledMessagesRepository, "findById").mockResolvedValue(inserted)
    spyOn(ScheduledMessagesRepository, "setQueueMessageId").mockResolvedValue(undefined)
    const queueInsert = spyOn(QueueRepository, "insert").mockResolvedValue({} as any)
    const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.schedule({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      streamId: STREAM_ID,
      parentMessageId: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hello",
      attachmentIds: [],
      metadata: null,
      scheduledFor: FUTURE,
      clientMessageId: null,
    })

    expect(queueInsert).toHaveBeenCalledTimes(1)
    expect(outboxInsert).toHaveBeenCalledWith(expect.anything(), "scheduled_message:upserted", expect.any(Object))
  })
})

describe("ScheduledMessagesService.lockForEdit (worker pause)", () => {
  afterEach(() => mock.restore())

  it("rejects when the row is already in flight (status != pending)", async () => {
    const service = setupService()
    spyOn(ScheduledMessagesRepository, "findById").mockResolvedValue(
      fakeScheduled({ status: ScheduledMessageStatuses.SENDING })
    )

    await expect(service.lockForEdit({ workspaceId: WORKSPACE_ID, userId: USER_ID, id: SCHEDULED_ID })).rejects.toThrow(
      /already/i
    )
  })

  it("succeeds even when another device already pushed the fence forward (anonymous, no owner)", async () => {
    // The fence is "is anyone editing right now?", not "did *this* device
    // claim it". Two devices opening the same row both succeed; bumpEditFence
    // GREATESTs the fence forward so neither pulls it backwards.
    const service = setupService()
    const fenceFromAnotherSession = new Date(Date.now() + 30_000)
    const row = fakeScheduled({ editActiveUntil: fenceFromAnotherSession })
    spyOn(ScheduledMessagesRepository, "findById").mockResolvedValue(row)
    const bumpEditFence = spyOn(ScheduledMessagesRepository, "bumpEditFence").mockResolvedValue({
      ...row,
      editActiveUntil: new Date(Date.now() + 10 * 60_000),
    })

    const result = await service.lockForEdit({ workspaceId: WORKSPACE_ID, userId: USER_ID, id: SCHEDULED_ID })

    expect(result.editActiveUntil.getTime()).toBeGreaterThan(Date.now())
    expect(bumpEditFence).toHaveBeenCalledTimes(1)
  })

  it("returns the row's current version so the dialog can refresh stale IDB state", async () => {
    // Why this matters: an IDB row that was cached before the version
    // migration shipped doesn't carry a `version` field. The dialog reads
    // `scheduled.version` for its expectedVersion guard — undefined → save
    // silently bails (`expectedVersion === null`). The lock response is
    // the dialog's chance to refresh that state from an authoritative
    // source before the user even attempts to save.
    const service = setupService()
    const row = fakeScheduled({ version: 7 })
    spyOn(ScheduledMessagesRepository, "findById").mockResolvedValue(row)
    spyOn(ScheduledMessagesRepository, "bumpEditFence").mockResolvedValue({
      ...row,
      editActiveUntil: new Date(Date.now() + 10 * 60_000),
    })

    const result = await service.lockForEdit({ workspaceId: WORKSPACE_ID, userId: USER_ID, id: SCHEDULED_ID })

    expect(result.scheduled.version).toBe(7)
    expect(result.scheduled.id).toBe(SCHEDULED_ID)
  })
})

describe("ScheduledMessagesService.cancel", () => {
  afterEach(() => mock.restore())

  it("cancels the queue row in the same tx as the status flip (worker can never fire a cancelled row)", async () => {
    const service = setupService()
    const row = fakeScheduled({ queueMessageId: "schedq_1" })
    spyOn(ScheduledMessagesRepository, "findById").mockResolvedValue(row)
    spyOn(ScheduledMessagesRepository, "cancel").mockResolvedValue({
      ...row,
      status: ScheduledMessageStatuses.CANCELLED,
    })
    const queueCancel = spyOn(QueueRepository, "cancelById").mockResolvedValue(true)
    const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.cancel({ workspaceId: WORKSPACE_ID, userId: USER_ID, id: SCHEDULED_ID })

    expect(queueCancel).toHaveBeenCalledWith(expect.anything(), "schedq_1")
    expect(outboxInsert).toHaveBeenCalledWith(expect.anything(), "scheduled_message:cancelled", expect.any(Object))
  })

  it("rejects with 409 ALREADY_SENDING when the row has already moved out of pending", async () => {
    const service = setupService()
    spyOn(ScheduledMessagesRepository, "findById").mockResolvedValue(
      fakeScheduled({ status: ScheduledMessageStatuses.SENDING })
    )

    await expect(service.cancel({ workspaceId: WORKSPACE_ID, userId: USER_ID, id: SCHEDULED_ID })).rejects.toThrow(
      /cannot cancel/i
    )
  })
})

describe("ScheduledMessagesService.update (optimistic CAS)", () => {
  afterEach(() => mock.restore())

  it("rejects with STALE_VERSION when expectedVersion no longer matches (first save wins)", async () => {
    const service = setupService()
    spyOn(ScheduledMessagesRepository, "findById").mockResolvedValue(fakeScheduled({ version: 5 }))
    spyOn(ScheduledMessagesRepository, "update").mockResolvedValue(null)

    await expect(
      service.update({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        id: SCHEDULED_ID,
        expectedVersion: 3,
        contentMarkdown: "x",
      })
    ).rejects.toThrow(/edited elsewhere/i)
  })

  it("flips status to sending and finalizes the send when scheduled_for is in the past", async () => {
    // The save-when-past-time UX: PATCH performs the createMessage call
    // atomically inside the same tx as the update + tryStartSend CAS.
    const createMessage = mock(async () => ({
      id: "msg_42",
      streamId: STREAM_ID,
      sequence: 1n,
      authorId: USER_ID,
      authorType: "user" as const,
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
    }))
    const service = setupService({ createMessage } as unknown as EventService)

    const past = new Date(Date.now() - 5_000)
    const row = fakeScheduled({ version: 4, scheduledFor: past })

    spyOn(ScheduledMessagesRepository, "findById")
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, contentMarkdown: "edited" })
    spyOn(ScheduledMessagesRepository, "update").mockResolvedValue({ ...row, contentMarkdown: "edited" })
    const tryStartSend = spyOn(ScheduledMessagesRepository, "tryStartSend").mockResolvedValue({
      ...row,
      contentMarkdown: "edited",
      status: ScheduledMessageStatuses.SENDING,
    })
    spyOn(ScheduledMessagesRepository, "markSent").mockResolvedValue({
      ...row,
      contentMarkdown: "edited",
      status: ScheduledMessageStatuses.SENT,
      sentMessageId: "msg_42",
    })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.update({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      id: SCHEDULED_ID,
      expectedVersion: 4,
      contentMarkdown: "edited",
      scheduledFor: past,
    })

    expect(result.status).toBe(ScheduledMessageStatuses.SENT)
    expect(createMessage).toHaveBeenCalledTimes(1)
    expect(tryStartSend).toHaveBeenCalledTimes(1)
    // The user owns the dialog lock; we must bypass it on their save or the
    // fence the user themselves set would block the user's own send.
    expect(tryStartSend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bypassFence: true }))
  })

  it("past-time save bypasses the user's own edit fence (deadlock regression)", async () => {
    // Bug we're guarding against: user opens dialog (sets edit_active_until
    // ~10 min from now via lockForEdit), wire passes while typing, user
    // hits Save → past-time path → tryStartSend honored the fence and 409'd
    // because the *user themselves* set it. Worker also fenced. Stuck.
    const createMessage = mock(async () => ({
      id: "msg_99",
      streamId: STREAM_ID,
      sequence: 1n,
      authorId: USER_ID,
      authorType: "user" as const,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "edited",
      replyCount: 0,
      clientMessageId: null,
      sentVia: null,
      reactions: {},
      metadata: {},
      editedAt: null,
      deletedAt: null,
      createdAt: NOW,
    }))
    const service = setupService({ createMessage } as unknown as EventService)

    const past = new Date(Date.now() - 5_000)
    const fenceActive = new Date(Date.now() + 10 * 60_000)
    const row = fakeScheduled({ version: 4, scheduledFor: past, editActiveUntil: fenceActive })

    spyOn(ScheduledMessagesRepository, "findById")
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, contentMarkdown: "edited" })
    spyOn(ScheduledMessagesRepository, "update").mockResolvedValue({ ...row, contentMarkdown: "edited" })
    spyOn(ScheduledMessagesRepository, "tryStartSend").mockResolvedValue({
      ...row,
      contentMarkdown: "edited",
      status: ScheduledMessageStatuses.SENDING,
    })
    spyOn(ScheduledMessagesRepository, "markSent").mockResolvedValue({
      ...row,
      contentMarkdown: "edited",
      status: ScheduledMessageStatuses.SENT,
      sentMessageId: "msg_99",
    })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.update({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      id: SCHEDULED_ID,
      expectedVersion: 4,
      contentMarkdown: "edited",
      scheduledFor: past,
    })

    expect(result.status).toBe(ScheduledMessageStatuses.SENT)
  })
})

describe("ScheduledMessagesService.fire (worker entry)", () => {
  afterEach(() => mock.restore())

  it("does nothing when the row is missing", async () => {
    const service = setupService()
    spyOn(ScheduledMessagesRepository, "findByIdScoped").mockResolvedValue(null)

    const result = await service.fire({ workspaceId: WORKSPACE_ID, scheduledMessageId: SCHEDULED_ID })
    expect(result).toEqual({ fired: false, reschedule: false })
  })

  it("does nothing when the row is no longer pending (cancelled/sent race)", async () => {
    const service = setupService()
    spyOn(ScheduledMessagesRepository, "findByIdScoped").mockResolvedValue(
      fakeScheduled({ status: ScheduledMessageStatuses.CANCELLED })
    )

    const result = await service.fire({ workspaceId: WORKSPACE_ID, scheduledMessageId: SCHEDULED_ID })
    expect(result).toEqual({ fired: false, reschedule: false })
  })

  it("drops a stale leased queue row when the row was rescheduled to the future", async () => {
    // The reschedule cancel races with a worker that already leased the old
    // queue row. If the worker tries to fire after the editor pushes
    // scheduled_for forward, we must drop the tick — marking the row failed
    // would tombstone a perfectly valid future-scheduled message. The fresh
    // queue row enqueued by the editor will fire at the new time.
    const service = setupService()
    const future = new Date(Date.now() + 60 * 60_000)
    spyOn(ScheduledMessagesRepository, "findByIdScoped").mockResolvedValue(fakeScheduled({ scheduledFor: future }))
    const tryStartSend = spyOn(ScheduledMessagesRepository, "tryStartSend")
    const markFailed = spyOn(ScheduledMessagesRepository, "markFailed")

    const result = await service.fire({ workspaceId: WORKSPACE_ID, scheduledMessageId: SCHEDULED_ID })

    expect(result).toEqual({ fired: false, reschedule: false })
    expect(tryStartSend).not.toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
  })

  it("defers when an editor session has bumped the fence (worker fence)", async () => {
    // A live editor session keeps the fence in the future. The worker must
    // defer rather than firing — the editor's first save is the canonical
    // version of the row, not whatever's still on disk.
    const service = setupService()
    const due = new Date(Date.now() - 1_000)
    const futureFence = new Date(Date.now() + 30_000)
    spyOn(ScheduledMessagesRepository, "findByIdScoped").mockResolvedValue(
      fakeScheduled({ scheduledFor: due, editActiveUntil: futureFence })
    )
    const tryStartSend = spyOn(ScheduledMessagesRepository, "tryStartSend")

    const result = await service.fire({ workspaceId: WORKSPACE_ID, scheduledMessageId: SCHEDULED_ID })

    expect(result).toEqual({ fired: false, reschedule: true })
    expect(tryStartSend).not.toHaveBeenCalled()
  })

  it("requests a reschedule when the start-send CAS returns null (fence race)", async () => {
    const service = setupService()
    const due = new Date(Date.now() - 1_000)
    spyOn(ScheduledMessagesRepository, "findByIdScoped").mockResolvedValue(fakeScheduled({ scheduledFor: due }))
    spyOn(ScheduledMessagesRepository, "tryStartSend").mockResolvedValue(null)

    const result = await service.fire({ workspaceId: WORKSPACE_ID, scheduledMessageId: SCHEDULED_ID })
    expect(result).toEqual({ fired: false, reschedule: true })
  })

  it("calls EventService.createMessage and marks sent on a successful CAS (full happy path)", async () => {
    const createMessage = mock(async () => ({
      id: "msg_42",
      streamId: STREAM_ID,
      sequence: 1n,
      authorId: USER_ID,
      authorType: "user" as const,
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
    }))
    const service = setupService({ createMessage } as unknown as EventService)
    const due = new Date(Date.now() - 1_000)
    const row = fakeScheduled({ scheduledFor: due })
    spyOn(ScheduledMessagesRepository, "findByIdScoped").mockResolvedValue(row)
    spyOn(ScheduledMessagesRepository, "tryStartSend").mockResolvedValue({
      ...row,
      status: ScheduledMessageStatuses.SENDING,
    })
    spyOn(ScheduledMessagesRepository, "markSent").mockResolvedValue({
      ...row,
      status: ScheduledMessageStatuses.SENT,
      sentMessageId: "msg_42",
    })
    const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.fire({ workspaceId: WORKSPACE_ID, scheduledMessageId: SCHEDULED_ID })

    expect(result).toEqual({ fired: true, reschedule: false })
    expect(createMessage).toHaveBeenCalledTimes(1)
    // The clientMessageId we pass to createMessage uses the scheduled-row id so
    // an interrupted finalize (process restart between createMessage and
    // markSent) doesn't double-send when the worker re-runs.
    const call = (createMessage as any).mock.calls[0][0]
    expect(call.clientMessageId).toBe(`scheduled:${SCHEDULED_ID}`)
    expect(outboxInsert).toHaveBeenCalledWith(expect.anything(), "scheduled_message:sent", expect.any(Object))
  })
})
