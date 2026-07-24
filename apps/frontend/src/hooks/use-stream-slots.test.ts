import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import { sharedMessageSlotKey, type SharedMessageSlot } from "@threa/types"
import { useStreamSlots } from "./use-stream-slots"

function slot(messageId: string): SharedMessageSlot {
  return { type: "sharedMessage", state: "missing", messageId }
}

async function seed(streamId: string, messageId: string) {
  await db.slots.put({
    workspaceId: "ws_1",
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

    const { result } = renderHook(() => useStreamSlots("stream_a"))

    await waitFor(() => expect(result.current).toEqual({ [sharedMessageSlotKey("msg_1")]: slot("msg_1") }))
  })

  it("re-emits when a slot row is written live", async () => {
    await seed("stream_a", "msg_1")
    const { result } = renderHook(() => useStreamSlots("stream_a"))
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
    const { result, rerender } = renderHook(({ id }) => useStreamSlots(id), {
      initialProps: { id: "stream_a" },
    })
    await waitFor(() => expect(result.current).toEqual({ [sharedMessageSlotKey("msg_1")]: slot("msg_1") }))

    // Switch to an empty stream: must not expose stream_a's map for a render.
    rerender({ id: "stream_b" })
    await waitFor(() => expect(result.current).toEqual({}))
  })

  it("returns undefined when no streamId is given", () => {
    const { result } = renderHook(() => useStreamSlots(null))
    expect(result.current).toBeUndefined()
  })
})
