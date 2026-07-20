import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { commandsApi } from "@/api"
import { db, sequenceToNum, type CachedEvent } from "@/db"
import { processOperationQueue, reclaimStaleCommandAttempts } from "@/sync/operation-queue"
import { cancelCommandDispatch } from "./use-command-dispatch-queue"

const commandId = "temp_cmd_1"
const streamId = "stream_1"
const originalLocks = navigator.locks

function commandEvent(id: string, eventType: "command_dispatched" | "command_failed"): CachedEvent {
  return {
    id,
    workspaceId: "ws_1",
    streamId,
    sequence: id === commandId ? "1000" : "1001",
    _sequenceNum: sequenceToNum(id === commandId ? "1000" : "1001"),
    eventType,
    payload:
      eventType === "command_dispatched"
        ? { commandId, name: "thinking", args: "low" }
        : { commandId, error: "Unknown command" },
    actorId: "user_1",
    actorType: "user",
    createdAt: "2026-01-01T20:30:00.000Z",
    _status: "failed",
    _anchorSequenceNum: 4,
    _cachedAt: 1,
  }
}

describe("cancelCommandDispatch", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.events.clear()
    await db.pendingOperations.clear()
  })

  afterEach(() => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks })
  })

  it("removes the local command lifecycle and queued dispatch", async () => {
    await db.events.bulkPut([
      commandEvent(commandId, "command_dispatched"),
      commandEvent(`${commandId}:failed`, "command_failed"),
    ])
    await db.pendingOperations.add({
      id: "op_1",
      workspaceId: "ws_1",
      type: "dispatch_command",
      payload: { streamId, command: "/thinking low", optimisticEventId: commandId },
      createdAt: 1,
      retryCount: 0,
    })

    await cancelCommandDispatch(streamId, commandId)

    expect(await db.events.where("streamId").equals(streamId).toArray()).toEqual([])
    expect(await db.pendingOperations.toArray()).toEqual([])
  })

  it("reclaims a crashed dispatch attempt after its Web Lock is released", async () => {
    await db.pendingOperations.add({
      id: "op_stale",
      workspaceId: "ws_1",
      type: "dispatch_command",
      payload: { streamId, command: "/thinking low", optimisticEventId: commandId },
      createdAt: 1,
      retryCount: 0,
      attempting: true,
    })
    const request = vi.fn(async (_name: string, callback: (lock: Lock) => Promise<boolean>) => callback({} as Lock))
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } })

    expect(await reclaimStaleCommandAttempts()).toBe(true)

    expect((await db.pendingOperations.get("op_stale"))?.attempting).toBe(false)
  })

  it("preserves the ordering anchor when a dispatch fails permanently", async () => {
    const dispatched = commandEvent(commandId, "command_dispatched")
    dispatched._status = "pending"
    await db.events.put(dispatched)
    await db.pendingOperations.add({
      id: "op_failed",
      workspaceId: "ws_1",
      type: "dispatch_command",
      payload: { streamId, command: "/thinking low", optimisticEventId: commandId },
      createdAt: 1,
      retryCount: 0,
    })
    vi.spyOn(commandsApi, "dispatch").mockResolvedValue({ success: false, error: "Unknown command" })

    await processOperationQueue(
      { update: vi.fn(), delete: vi.fn() },
      { add: vi.fn(), remove: vi.fn() },
      undefined,
      undefined,
      () => true
    )

    expect((await db.events.get(`${commandId}:failed`))?._anchorSequenceNum).toBe(4)
  })

  it("refuses cancellation while a dispatch request is in flight", async () => {
    await db.events.put(commandEvent(commandId, "command_dispatched"))
    await db.pendingOperations.add({
      id: "op_1",
      workspaceId: "ws_1",
      type: "dispatch_command",
      payload: { streamId, command: "/thinking low", optimisticEventId: commandId },
      createdAt: 1,
      retryCount: 0,
    })

    let resolveDispatch!: (value: Awaited<ReturnType<typeof commandsApi.dispatch>>) => void
    const dispatchResult = new Promise<Awaited<ReturnType<typeof commandsApi.dispatch>>>((resolve) => {
      resolveDispatch = resolve
    })
    vi.spyOn(commandsApi, "dispatch").mockReturnValue(dispatchResult)

    const processing = processOperationQueue(
      { update: vi.fn(), delete: vi.fn() },
      { add: vi.fn(), remove: vi.fn() },
      undefined,
      undefined,
      () => true
    )
    await vi.waitFor(() => expect(commandsApi.dispatch).toHaveBeenCalledOnce())
    expect(await cancelCommandDispatch(streamId, commandId)).toBe(false)
    resolveDispatch({
      success: true,
      commandId: "cmd_confirmed",
      command: "thinking",
      args: "low",
      event: {
        id: "evt_confirmed",
        streamId,
        sequence: "10",
        eventType: "command_dispatched",
        payload: { commandId: "cmd_confirmed", name: "thinking", args: "low", status: "dispatched" },
        actorId: "user_1",
        actorType: "user",
        createdAt: "2026-01-01T20:30:01.000Z",
      },
    })
    await processing

    expect((await db.events.toArray()).map((event) => event.id)).toEqual(["evt_confirmed"])
  })
})
