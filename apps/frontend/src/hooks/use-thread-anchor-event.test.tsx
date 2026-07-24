import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import type { StreamEvent } from "@threa/types"
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useThreadAnchorEvent", () => {
  it("fetches the exact card when the anchor is outside cached/bootstrap windows", async () => {
    const anchor = event("event_anchor")
    getEventsAround.mockResolvedValue({
      events: [event("event_before"), anchor],
      hasOlder: true,
      hasNewer: true,
      sharedMessages: { msg_shared: { type: "sharedMessage", state: "missing", messageId: "msg_shared" } },
    })

    const { result } = renderHook(() => useThreadAnchorEvent("ws_1", "stream_parent", "event_anchor", null), {
      wrapper: wrapper(),
    })

    await waitFor(() => expect(result.current.event).toBe(anchor))
    expect(getEventsAround).toHaveBeenCalledWith("ws_1", "stream_parent", "event_anchor", 2)
    expect(result.current.sharedMessages).toEqual({
      msg_shared: { type: "sharedMessage", state: "missing", messageId: "msg_shared" },
    })
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
