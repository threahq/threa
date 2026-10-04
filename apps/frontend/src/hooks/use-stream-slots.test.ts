import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import { sharedMessageSlotKey, type SharedMessageSlot, type SlotMap } from "@threahq/types"
import { useStreamSlots } from "./use-stream-slots"

function slot(messageId: string): SharedMessageSlot {
  return { type: "sharedMessage", state: "missing", messageId }
}

async function seed(streamId: string, messageId: string, workspaceId = "ws_1") {
  await db.slots.put({
    workspaceId,
    streamId,
    slotKey: sharedMessageSlotKey(messageId),
    value: slot(messageId),
    _cachedAt: Date.now(),
  })
}

beforeEach(async () => {
  await db.slots.clear()
})

describe("useStreamSlots", () => {
  it("materializes the stream's canonical slot map from db.slots", async () => {
    await seed("stream_a", "msg_1")

    const { result } = renderHook(() => useStreamSlots("ws_1", "stream_a"))

    await waitFor(() => expect(result.current).toEqual({ [sharedMessageSlotKey("msg_1")]: slot("msg_1") }))
  })

  it("re-emits when a slot row is written live", async () => {
    await seed("stream_a", "msg_1")
    const { result } = renderHook(() => useStreamSlots("ws_1", "stream_a"))
    await waitFor(() => expect(result.current).toEqual({ [sharedMessageSlotKey("msg_1")]: slot("msg_1") }))

    await act(() => seed("stream_a", "msg_2"))

    await waitFor(() =>
      expect(result.current).toEqual({
        [sharedMessageSlotKey("msg_1")]: slot("msg_1"),
        [sharedMessageSlotKey("msg_2")]: slot("msg_2"),
      })
    )
  })

  it("returns an empty map for a stream with no rows once resolved (not the previous stream's map)", async () => {
    await seed("stream_a", "msg_1")
    const { result, rerender } = renderHook(({ id }) => useStreamSlots("ws_1", id), {
      initialProps: { id: "stream_a" },
    })
    await waitFor(() => expect(result.current).toEqual({ [sharedMessageSlotKey("msg_1")]: slot("msg_1") }))

    // Switch to an empty stream: must not expose stream_a's map for a render.
    rerender({ id: "stream_b" })
    await waitFor(() => expect(result.current).toEqual({}))
  })

  it("returns each workspace's own map when a copied stream id exists in two workspaces", async () => {
    await seed("stream_a", "msg_a", "ws_a")
    await seed("stream_a", "msg_b", "ws_b")

    const { result: inA } = renderHook(() => useStreamSlots("ws_a", "stream_a"))
    const { result: inB } = renderHook(() => useStreamSlots("ws_b", "stream_a"))

    await waitFor(() => expect(inA.current).toEqual({ [sharedMessageSlotKey("msg_a")]: slot("msg_a") }))
    await waitFor(() => expect(inB.current).toEqual({ [sharedMessageSlotKey("msg_b")]: slot("msg_b") }))
  })

  it("should never return the previous workspace's map when the same stream id switches workspace", async () => {
    await seed("stream_a", "msg_a", "ws_a")
    await seed("stream_a", "msg_b", "ws_b")
    const seen: Array<{ workspaceId: string; map: SlotMap | undefined }> = []

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) => {
        const map = useStreamSlots(workspaceId, "stream_a")
        seen.push({ workspaceId, map })
        return map
      },
      { initialProps: { workspaceId: "ws_a" } }
    )
    await waitFor(() => expect(result.current).toEqual({ [sharedMessageSlotKey("msg_a")]: slot("msg_a") }))
    rerender({ workspaceId: "ws_b" })
    await waitFor(() => expect(result.current).toEqual({ [sharedMessageSlotKey("msg_b")]: slot("msg_b") }))

    expect(
      seen.filter((render) => render.workspaceId === "ws_b" && render.map?.[sharedMessageSlotKey("msg_a")])
    ).toEqual([])
  })

  it("returns undefined when no streamId is given", () => {
    const { result } = renderHook(() => useStreamSlots("ws_1", null))
    expect(result.current).toBeUndefined()
  })
})
