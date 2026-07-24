import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import { db } from "@/db"
import { sharedMessageSlotKey, type SlotMap, type StreamEvent } from "@threa/types"
import { useThreadAnchorEvent } from "./use-thread-anchor-event"

const getEventsAround = vi.fn<StreamService["getEventsAround"]>()

function event(id: string): StreamEvent {
  return {
    id,
    streamId: "stream_parent",
    sequence: "1",
    broadcastSequence: "1",
    eventType: "delegation:created",
    actorId: "usr_1",
    actorType: "user",
    createdAt: new Date().toISOString(),
    payload: {},
  }
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ServicesProvider, {
        services: { streams: { getEventsAround } as unknown as StreamService },
        children,
      })
    )
  }
}

async function readSlotMap(streamId: string): Promise<SlotMap> {
  const rows = await db.slots.where("streamId").equals(streamId).toArray()
  const map: SlotMap = {}
  for (const row of rows) map[row.slotKey] = row.value
  return map
}

beforeEach(async () => {
  vi.clearAllMocks()
  await db.slots.clear()
})

describe("useThreadAnchorEvent", () => {
  it("fetches the exact card and writes the carrier's slots under the parent stream", async () => {
    const anchor = event("event_anchor")
    const slot = { type: "sharedMessage", state: "missing", messageId: "msg_shared" } as const
    getEventsAround.mockResolvedValue({
      events: [event("event_before"), anchor],
      hasOlder: true,
      hasNewer: true,
      slots: { [sharedMessageSlotKey("msg_shared")]: slot },
    })

    const { result } = renderHook(() => useThreadAnchorEvent("ws_1", "stream_parent", "event_anchor", null), {
      wrapper: wrapper(),
    })

    await waitFor(() => expect(result.current.event).toBe(anchor))
    expect(getEventsAround).toHaveBeenCalledWith("ws_1", "stream_parent", "event_anchor", 2)
    // The hook returns the event only; the slot map is persisted, not returned.
    expect(result.current).toEqual({ event: anchor })
    await waitFor(async () =>
      expect(await readSlotMap("stream_parent")).toEqual({ [sharedMessageSlotKey("msg_shared")]: slot })
    )
  })

  it("rekeys a legacy-only carrier to canonical keys under the parent stream", async () => {
    const anchor = event("event_anchor")
    const slot = { type: "sharedMessage", state: "missing", messageId: "msg_shared" } as const
    getEventsAround.mockResolvedValue({
      events: [anchor],
      hasOlder: false,
      hasNewer: true,
      sharedMessages: { msg_shared: slot },
    })

    const { result } = renderHook(() => useThreadAnchorEvent("ws_1", "stream_parent", "event_anchor", null), {
      wrapper: wrapper(),
    })

    await waitFor(() => expect(result.current.event).toBe(anchor))
    await waitFor(async () =>
      expect(await readSlotMap("stream_parent")).toEqual({ [sharedMessageSlotKey("msg_shared")]: slot })
    )
  })

  it("uses a local anchor without issuing a targeted request", () => {
    const anchor = event("event_anchor")
    const { result } = renderHook(() => useThreadAnchorEvent("ws_1", "stream_parent", "event_anchor", anchor), {
      wrapper: wrapper(),
    })

    expect(result.current).toEqual({ event: anchor })
    expect(getEventsAround).not.toHaveBeenCalled()
  })
})
