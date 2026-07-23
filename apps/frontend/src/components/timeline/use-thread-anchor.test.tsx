import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { PanelProvider } from "@/contexts"
import { useThreadAnchor } from "./use-thread-anchor"

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <PanelProvider>{children}</PanelProvider>
    </MemoryRouter>
  )
}

describe("useThreadAnchor", () => {
  it("points reply at the draft panel when no thread exists yet", () => {
    const { result } = renderHook(() => useThreadAnchor("stream_1", "msg_a", {}), { wrapper })
    expect(result.current.effectiveThreadId).toBeUndefined()
    expect(result.current.threadHref).toBeNull()
    expect(result.current.draftPanelUrl).toBe("/w/ws_1?panel=draft%3Astream_1%3Amsg_a")
    expect(result.current.replyUrl).toBe(result.current.draftPanelUrl)
  })

  it("points reply at the real thread once a threadId is known", () => {
    const { result } = renderHook(() => useThreadAnchor("stream_1", "msg_a", { threadId: "stream_thread" }), {
      wrapper,
    })
    expect(result.current.effectiveThreadId).toBe("stream_thread")
    expect(result.current.threadHref).toBe("/w/ws_1?panel=stream_thread")
    expect(result.current.replyUrl).toBe(result.current.threadHref)
  })

  it("falls back to an in-flight agent thread stream id", () => {
    const { result } = renderHook(
      () => useThreadAnchor("stream_1", "msg_a", { activityThreadStreamId: "stream_inflight" }),
      { wrapper }
    )
    expect(result.current.effectiveThreadId).toBe("stream_inflight")
    expect(result.current.threadHref).toBe("/w/ws_1?panel=stream_inflight")
  })

  it("keys the draft panel on a card (event) anchor too", () => {
    const { result } = renderHook(() => useThreadAnchor("stream_1", "event_c", {}), { wrapper })
    expect(result.current.draftPanelUrl).toBe("/w/ws_1?panel=draft%3Astream_1%3Aevent_c")
  })
})
