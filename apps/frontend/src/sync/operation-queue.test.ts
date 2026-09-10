import { describe, it, expect, beforeEach, vi } from "vitest"
import { AuthErrorCodes } from "@threahq/types"
import { db, getActiveDb, ThreaDatabase, accountDbName, type CachedScheduledMessage } from "@/db"
import { setActiveDb } from "@/db/database"
import * as apiModule from "@/api"
import { ApiError } from "@/api"
import * as streamSyncModule from "./stream-sync"
import { retireAccountWork } from "./account-fence"
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

function wireDraftRow(id: string, version: number) {
  return {
    id,
    workspaceId,
    userId: "usr_1",
    scope: "stream:stream_1",
    rootStreamId: null,
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "",
    attachmentIds: [],
    command: null,
    contextRefs: null,
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    version,
    clientUpdatedAt: new Date(1000).toISOString(),
    stashedAt: null,
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
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
  await db.drafts.clear()
  await db.composerLoaded.clear()
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

    const retryAt = await processOperationQueue(
      messageService,
      reactionService,
      scheduledServiceRejectingWith(new TypeError("Failed to fetch")),
      undefined,
      () => true
    )

    const [op] = await db.pendingOperations.toArray()
    expect({ operation: op, retryAt }).toMatchObject({
      operation: { type: "send_scheduled_now", retryCount: 1 },
      retryAt: expect.any(Number),
    })
    expect(retryAt).toBe(op?.retryAfter)
  })

  it("retains the op for retry on 429", async () => {
    await enqueueOperation(workspaceId, "send_scheduled_now", { id: schedId })

    await process(scheduledServiceRejectingWith(new ApiError(429, "RATE_LIMITED", "Slow down")))

    const [op] = await db.pendingOperations.toArray()
    expect(op).toMatchObject({ type: "send_scheduled_now", retryCount: 1 })
  })
})

describe("processOperationQueue account ownership", () => {
  it("should keep an op the server refused because this browser's account moved", async () => {
    await db.scheduledMessages.put(cachedScheduledRow())
    await enqueueOperation(workspaceId, "send_scheduled_now", { id: schedId })

    const scheduledService = scheduledServiceRejectingWith(
      new ApiError(409, AuthErrorCodes.ACCOUNT_MISMATCH, "This browser is signed in as a different account")
    )
    await process(scheduledService)

    // A mismatch is not a verdict on the payload: the op and the row it would
    // reconcile away both survive, so the account that queued it can still
    // replay it when it comes back.
    const [op] = await db.pendingOperations.toArray()
    expect(op).toMatchObject({ type: "send_scheduled_now", retryCount: 1 })
    expect(await db.scheduledMessages.get(schedId)).toMatchObject({ id: schedId })
  })

  it("should stop replaying operations once its account switches away", async () => {
    await enqueueOperation(workspaceId, "send_scheduled_now", { id: schedId })

    let releaseSend: () => void = () => {}
    const scheduledService = {
      create: vi.fn(),
      delete: vi.fn(),
      sendNow: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseSend = () => resolve(undefined)
          })
      ),
    }

    const draining = processOperationQueue(
      messageService,
      reactionService,
      scheduledService as unknown as Parameters<typeof processOperationQueue>[2],
      undefined,
      () => true
    )
    await vi.waitFor(() => expect(scheduledService.sendNow).toHaveBeenCalledTimes(1))

    const retired = retireAccountWork(1000)
    releaseSend()
    await retired
    await draining

    // The op stays exactly as the outgoing account left it — neither deleted
    // nor re-attempted under the account that replaced it.
    const [op] = await db.pendingOperations.toArray()
    expect(op).toMatchObject({ type: "send_scheduled_now", retryCount: 0 })
    expect(scheduledService.sendNow).toHaveBeenCalledTimes(1)
  })
})

describe("processOperationQueue database capture", () => {
  it("should bookkeep a command dispatch in the database it claimed the op from", async () => {
    // The dispatch's round-trip can outlive the account that queued it: past
    // the retire budget the `db` proxy already points at the replacement
    // account, and `bumpLaterOptimisticAnchors` defaults to that pointer.
    const claimedDb = getActiveDb()
    const optimisticEventId = "evt_optimistic_dispatch"
    await claimedDb.events.put({
      id: optimisticEventId,
      workspaceId,
      streamId: "stream_1",
      eventType: "command_dispatched",
      sequence: "10",
      _sequenceNum: 10,
      payload: { command: "/spawn" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: "2026-07-19T11:00:00.000Z",
      _status: "pending",
      _cachedAt: Date.now(),
    } as unknown as Parameters<typeof claimedDb.events.put>[0])
    await enqueueOperation(workspaceId, "dispatch_command", {
      optimisticEventId,
      streamId: "stream_1",
      command: "/spawn",
    })

    const bump = vi.spyOn(streamSyncModule, "bumpLaterOptimisticAnchors").mockResolvedValue(undefined)
    const replacementDb = new ThreaDatabase(accountDbName("user_replacement"))
    vi.spyOn(apiModule.commandsApi, "dispatch").mockImplementation(async () => {
      // The switch lands while the dispatch is on the wire.
      setActiveDb(replacementDb)
      return {
        success: true,
        event: {
          id: "evt_real",
          streamId: "stream_1",
          eventType: "command_dispatched",
          sequence: "11",
          payload: {},
          actorId: "usr_1",
          actorType: "user",
          createdAt: "2026-07-19T11:00:01.000Z",
        },
      } as unknown as Awaited<ReturnType<typeof apiModule.commandsApi.dispatch>>
    })

    try {
      await processOperationQueue(messageService, reactionService, undefined, undefined, () => true)
    } finally {
      setActiveDb(claimedDb)
    }

    expect(bump.mock.calls[0]?.[4]).toBe(claimedDb)
    expect(await replacementDb.events.toArray()).toEqual([])
    expect(await claimedDb.events.get("evt_real")).toMatchObject({ id: "evt_real" })
  })

  it("should land a scheduled send's server row in the database it claimed the op from", async () => {
    await db.scheduledMessages.put(cachedScheduledRow())
    await enqueueOperation(workspaceId, "send_scheduled_now", { id: schedId })

    const claimedDb = getActiveDb()
    const replacementDb = new ThreaDatabase(accountDbName("user_replacement_sched"))
    const scheduledService = {
      create: vi.fn(),
      delete: vi.fn(),
      sendNow: vi.fn(async () => {
        setActiveDb(replacementDb)
        return { ...cachedScheduledRow(), status: "sent" } as unknown as never
      }),
    }

    try {
      await processOperationQueue(
        messageService,
        reactionService,
        scheduledService as unknown as Parameters<typeof processOperationQueue>[2],
        undefined,
        () => true
      )
    } finally {
      setActiveDb(claimedDb)
    }

    expect(await replacementDb.scheduledMessages.toArray()).toEqual([])
    expect(await claimedDb.scheduledMessages.get(schedId)).toMatchObject({ status: "sent" })
  })

  it("should reconcile a split draft push entirely in the database it claimed the op from", async () => {
    // The split path is the deepest tail in the queue: an id migration, a
    // cancel, a re-enqueue and a kept-row seed, each its own await. Passing the
    // captured handle to `executeDraftUpsert` alone would still leave every one
    // of those resolving the *active* database — the replacement account's.
    const claimedDb = getActiveDb()
    await claimedDb.drafts.put({
      id: "draft_x",
      workspaceId,
      scope: "stream:stream_1",
      contentJson: { type: "doc", content: [] },
      attachments: [],
      baseVersion: 1,
      clientUpdatedAt: 1000,
      stashedAt: null,
    } as unknown as Parameters<typeof claimedDb.drafts.put>[0])
    await claimedDb.composerLoaded.put({ scope: "stream:stream_1", workspaceId, draftId: "draft_x" })
    await enqueueOperation(workspaceId, "upsert_draft", { draftId: "draft_x", writeId: "write_a" })

    const replacementDb = new ThreaDatabase(accountDbName("user_replacement_draft"))
    const draftsService = {
      upsert: vi.fn(async (_w: string, id: string) => {
        // The switch lands while the push is on the wire.
        setActiveDb(replacementDb)
        if (id !== "draft_x") return { draft: wireDraftRow(id, 6), split: false } as unknown as never
        return {
          draft: wireDraftRow("draft_new", 5),
          split: true,
          originalId: id,
          keptDraft: wireDraftRow("draft_x", 7),
        } as unknown as never
      }),
      resolve: vi.fn(),
      delete: vi.fn(),
    }

    try {
      await processOperationQueue(
        messageService,
        reactionService,
        undefined,
        draftsService as unknown as Parameters<typeof processOperationQueue>[3],
        () => true
      )
    } finally {
      setActiveDb(claimedDb)
    }

    // Not one row, pointer or queued op in the arriving account's storage.
    expect(await replacementDb.drafts.toArray()).toEqual([])
    expect(await replacementDb.composerLoaded.toArray()).toEqual([])
    expect(await replacementDb.pendingOperations.toArray()).toEqual([])

    // All of it in the account that queued the push: our content under the
    // server-minted id (composer following it) and the kept copy seeded back.
    expect(await claimedDb.drafts.get("draft_new")).toMatchObject({ id: "draft_new", baseVersion: 6 })
    expect(await claimedDb.drafts.get("draft_x")).toMatchObject({ id: "draft_x", baseVersion: 7 })
    expect((await claimedDb.composerLoaded.get("stream:stream_1"))?.draftId).toBe("draft_new")
    // The re-enqueued push for the migrated id was queued in — and drained
    // from — the claimed database, so it actually reached the server.
    expect(draftsService.upsert.mock.calls.map((call) => call[1])).toEqual(["draft_x", "draft_new"])
  })
})
