import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { StrictMode, type ReactNode } from "react"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { JSONContent } from "@threahq/types"
import { db, sequenceToNum, type CachedEvent } from "@/db"
import { peekShareHandoffBatch, resetShareHandoffStoreCache } from "@/stores/composer-handoff-store"
import { useCommandFailureRestore } from "./use-command-failure-restore"

const workspaceId = "ws_1"
const streamId = "stream_1"
const optimisticId = "temp_cmd_1"

const commandDoc: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "slashCommand", attrs: { name: "spawn" } },
        { type: "text", text: " x" },
      ],
    },
  ],
}

function event(
  id: string,
  eventType: CachedEvent["eventType"],
  payload: Record<string, unknown>,
  overrides: Partial<CachedEvent> = {}
): CachedEvent {
  return {
    id,
    workspaceId,
    streamId,
    sequence: "1000",
    _sequenceNum: sequenceToNum("1000"),
    eventType,
    payload,
    actorId: "usr_1",
    actorType: "user",
    createdAt: "2026-09-16T10:00:00.000Z",
    _cachedAt: 1,
    ...overrides,
  }
}

const optimisticDispatched = () =>
  event(optimisticId, "command_dispatched", {
    commandId: optimisticId,
    name: "spawn",
    args: "x",
    status: "dispatched",
  })

const serverDispatched = () =>
  event("evt_server", "command_dispatched", {
    commandId: "cmd_server",
    clientCommandId: optimisticId,
    name: "spawn",
    args: "x",
    status: "dispatched",
  })

function render() {
  return renderHook(() => useCommandFailureRestore(streamId), {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  })
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
}

function restoredNodes(): JSONContent[] | null {
  const batch = peekShareHandoffBatch(streamId)
  if (!batch) return null
  const handoff = batch.handoffs.find((entry) => entry.kind === "content")
  return handoff?.kind === "content" ? [...handoff.content] : null
}

beforeEach(async () => {
  resetShareHandoffStoreCache()
  await db.events.clear()
})

afterEach(() => {
  cleanup()
  resetShareHandoffStoreCache()
})

describe("useCommandFailureRestore", () => {
  it("should hand the command content back when the local dispatch fails permanently", async () => {
    const { result } = render()
    act(() => result.current(optimisticId, commandDoc))

    await db.events.bulkPut([
      optimisticDispatched(),
      event(
        `${optimisticId}:failed`,
        "command_failed",
        { commandId: optimisticId, error: "Unknown command" },
        { _status: "failed" }
      ),
    ])

    await waitFor(() => expect(restoredNodes()).toEqual(commandDoc.content))
  })

  it("should restore when the server replaced the optimistic row and the command failed later", async () => {
    const { result } = render()
    act(() => result.current(optimisticId, commandDoc))

    await db.events.put(serverDispatched())
    await settle()
    expect(restoredNodes()).toBeNull()

    await db.events.put(
      event("evt_failed", "command_failed", { commandId: "cmd_server", error: "runtime gone" }, { sequence: "1001" })
    )

    await waitFor(() => expect(restoredNodes()).toEqual(commandDoc.content))
  })

  it("should restore nothing when the command completes, even if a failure lands for it afterwards", async () => {
    const { result } = render()
    act(() => result.current(optimisticId, commandDoc))

    await db.events.bulkPut([
      optimisticDispatched(),
      event("evt_done", "command_completed", { commandId: optimisticId }, { sequence: "1001" }),
    ])
    await settle()
    expect(restoredNodes()).toBeNull()

    await db.events.put(
      event(
        `${optimisticId}:failed`,
        "command_failed",
        { commandId: optimisticId, error: "late" },
        { sequence: "1002" }
      )
    )
    await settle()

    expect(peekShareHandoffBatch(streamId)).toBeNull()
  })

  it("should ignore a failure for a command this composer never dispatched", async () => {
    render()

    await db.events.bulkPut([
      event("temp_cmd_other", "command_dispatched", {
        commandId: "temp_cmd_other",
        name: "spawn",
        args: "",
        status: "dispatched",
      }),
      event("temp_cmd_other:failed", "command_failed", { commandId: "temp_cmd_other", error: "nope" }),
    ])
    await settle()

    expect(peekShareHandoffBatch(streamId)).toBeNull()
  })

  it("should ignore a failure that lands in another stream", async () => {
    const { result } = render()
    act(() => result.current(optimisticId, commandDoc))

    await db.events.bulkPut([
      event(
        optimisticId,
        "command_dispatched",
        { commandId: optimisticId, name: "spawn", args: "x", status: "dispatched" },
        { streamId: "stream_other" }
      ),
      event(
        `${optimisticId}:failed`,
        "command_failed",
        { commandId: optimisticId, error: "nope" },
        { streamId: "stream_other" }
      ),
    ])
    await settle()

    expect(peekShareHandoffBatch(streamId)).toBeNull()
    expect(peekShareHandoffBatch("stream_other")).toBeNull()
  })

  it("should restore once when the same failure is observed again", async () => {
    const { result } = render()
    act(() => result.current(optimisticId, commandDoc))

    const failed = event(`${optimisticId}:failed`, "command_failed", {
      commandId: optimisticId,
      error: "Unknown command",
    })
    await db.events.bulkPut([optimisticDispatched(), failed])
    await waitFor(() => expect(restoredNodes()).toEqual(commandDoc.content))

    // The same terminal event seen again (a sync re-put) must not re-insert.
    await db.events.put({ ...failed, _cachedAt: 2 })
    await settle()

    expect(peekShareHandoffBatch(streamId)?.handoffs).toHaveLength(1)
  })
})
