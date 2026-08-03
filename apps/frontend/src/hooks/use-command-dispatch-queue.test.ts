import { beforeEach, describe, expect, it, vi } from "vitest"
import { commandsApi } from "@/api"
import { db, sequenceToNum, type CachedEvent } from "@/db"
import { processOperationQueue } from "@/sync/operation-queue"
import { cancelCommandDispatch } from "./use-command-dispatch-queue"

const workspaceId = "ws_1"
const commandId = "temp_cmd_1"
const streamId = "stream_1"

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

    await cancelCommandDispatch(workspaceId, streamId, commandId)

    expect(await db.events.where("streamId").equals(streamId).toArray()).toEqual([])
    expect(await db.pendingOperations.toArray()).toEqual([])
  })

  it("does not cancel a command from another workspace", async () => {
    await db.events.put(commandEvent(commandId, "command_dispatched"))
    await db.pendingOperations.add({
      id: "op_other_workspace",
      workspaceId,
      type: "dispatch_command",
      payload: { streamId, command: "/thinking low", optimisticEventId: commandId },
      createdAt: 1,
      retryCount: 0,
    })

    expect(await cancelCommandDispatch("ws_other", streamId, commandId)).toBe(false)
    expect(await db.events.get(commandId)).toBeDefined()
    expect(await db.pendingOperations.get("op_other_workspace")).toBeDefined()
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

  it("forwards the queued conversation ref to the dispatch request", async () => {
    const dispatched = commandEvent(commandId, "command_dispatched")
    dispatched._status = "pending"
    await db.events.put(dispatched)
    await db.pendingOperations.add({
      id: "op_conv",
      workspaceId: "ws_1",
      type: "dispatch_command",
      payload: { streamId, command: "/thinking low", optimisticEventId: commandId, conversationId: "conv_1" },
      createdAt: 1,
      retryCount: 0,
    })
    const dispatch = vi.spyOn(commandsApi, "dispatch").mockResolvedValue({ success: false, error: "Unknown command" })

    await processOperationQueue(
      { update: vi.fn(), delete: vi.fn() },
      { add: vi.fn(), remove: vi.fn() },
      undefined,
      undefined,
      () => true
    )

    expect(dispatch.mock.calls[0][1]).toEqual({
      streamId,
      command: "/thinking low",
      clientCommandId: commandId,
      conversationId: "conv_1",
    })
  })

  it("refuses cancellation after an ambiguous transient failure", async () => {
    const dispatched = commandEvent(commandId, "command_dispatched")
    dispatched._status = "pending"
    await db.events.put(dispatched)
    await db.pendingOperations.add({
      id: "op_retry",
      workspaceId: "ws_1",
      type: "dispatch_command",
      payload: { streamId, command: "/thinking low", optimisticEventId: commandId },
      createdAt: 1,
      retryCount: 0,
    })
    vi.spyOn(commandsApi, "dispatch").mockRejectedValue(new Error("offline"))

    await processOperationQueue(
      { update: vi.fn(), delete: vi.fn() },
      { add: vi.fn(), remove: vi.fn() },
      undefined,
      undefined,
      () => true
    )

    expect((await db.pendingOperations.get("op_retry"))?.startedAt).toBeDefined()
    expect(await cancelCommandDispatch(workspaceId, streamId, commandId)).toBe(false)
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
    expect(commandsApi.dispatch).toHaveBeenCalledWith("ws_1", {
      streamId,
      command: "/thinking low",
      clientCommandId: commandId,
    })
    expect(await cancelCommandDispatch(workspaceId, streamId, commandId)).toBe(false)
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
