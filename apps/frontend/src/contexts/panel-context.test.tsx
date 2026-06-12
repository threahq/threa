import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ReactNode } from "react"
import { PanelProvider, usePanel, applyOpenPanel, isDraftPanel, isViewPanel, parseDraftPanel } from "./panel-context"

describe("applyOpenPanel", () => {
  it("appends the first panel regardless of mode", () => {
    expect(applyOpenPanel([], "a")).toEqual(["a"])
    expect(applyOpenPanel([], "a", { mode: "new" })).toEqual(["a"])
  })

  it("replaces the most recent panel by default", () => {
    expect(applyOpenPanel(["a", "b"], "c")).toEqual(["a", "c"])
  })

  it("replaces a specific target panel in place", () => {
    expect(applyOpenPanel(["a", "b", "c"], "x", { target: "a" })).toEqual(["x", "b", "c"])
  })

  it("falls back to the last panel when the target is not open", () => {
    expect(applyOpenPanel(["a", "b"], "x", { target: "gone" })).toEqual(["a", "x"])
  })

  it("appends in new mode", () => {
    expect(applyOpenPanel(["a"], "b", { mode: "new" })).toEqual(["a", "b"])
  })

  it("is a no-op when the panel is already open", () => {
    expect(applyOpenPanel(["a", "b"], "a")).toEqual(["a", "b"])
    expect(applyOpenPanel(["a", "b"], "a", { mode: "new" })).toEqual(["a", "b"])
  })
})

describe("panel id helpers", () => {
  it("classifies draft and view panel ids", () => {
    expect(isDraftPanel("draft:stream_1:msg_1")).toBe(true)
    expect(isDraftPanel("stream_1")).toBe(false)
    expect(isViewPanel("view:saved")).toBe(true)
    expect(isViewPanel("stream_1")).toBe(false)
  })

  it("parses draft panel ids", () => {
    expect(parseDraftPanel("draft:stream_1:msg_1")).toEqual({
      parentStreamId: "stream_1",
      parentMessageId: "msg_1",
    })
    expect(parseDraftPanel("draft:bad")).toBeNull()
  })
})

function wrapperWithUrl(initialUrl: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialUrl]}>
        <PanelProvider>{children}</PanelProvider>
      </MemoryRouter>
    )
  }
}

describe("PanelProvider", () => {
  it("reads the ordered panel list from repeated ?panel params", () => {
    const { result } = renderHook(() => usePanel(), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_1?panel=a&panel=b"),
    })
    expect(result.current.panels).toEqual(["a", "b"])
    expect(result.current.panelId).toBe("b")
    expect(result.current.isPanelOpen).toBe(true)
  })

  it("openPanel with mode new appends; closePanel removes a specific id", () => {
    const { result } = renderHook(() => usePanel(), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_1?panel=a"),
    })
    act(() => result.current.openPanel("b", { mode: "new" }))
    expect(result.current.panels).toEqual(["a", "b"])

    act(() => result.current.closePanel("a"))
    expect(result.current.panels).toEqual(["b"])
  })

  it("movePanel reorders within the strip", () => {
    const { result } = renderHook(() => usePanel(), {
      wrapper: wrapperWithUrl("/?panel=a&panel=b&panel=c"),
    })
    act(() => result.current.movePanel("c", 0))
    expect(result.current.panels).toEqual(["c", "a", "b"])
  })

  it("replacePanel swaps content in place and ignores self-replacement", () => {
    const { result } = renderHook(() => usePanel(), {
      wrapper: wrapperWithUrl("/?panel=a&panel=b"),
    })
    act(() => result.current.replacePanel("a", "x"))
    expect(result.current.panels).toEqual(["x", "b"])

    // Self-replacement must not drop the panel (draft promotion sets the
    // parent's threadId to the draft's own id at queue time).
    act(() => result.current.replacePanel("b", "b"))
    expect(result.current.panels).toEqual(["x", "b"])
  })

  it("closeAllPanels keeps only the excepted panel", () => {
    const { result } = renderHook(() => usePanel(), {
      wrapper: wrapperWithUrl("/?panel=a&panel=b&panel=c"),
    })
    act(() => result.current.closeAllPanels("b"))
    expect(result.current.panels).toEqual(["b"])
  })

  it("resets focus to main when the focused panel closes", () => {
    const { result } = renderHook(() => usePanel(), {
      wrapper: wrapperWithUrl("/?panel=a"),
    })
    act(() => result.current.setFocusedPane("a"))
    expect(result.current.getFocusedPane()).toBe("a")
    act(() => result.current.closePanel("a"))
    expect(result.current.getFocusedPane()).toBe("main")
  })

  it("getPanelUrl preserves sibling panels and other params", () => {
    const { result } = renderHook(() => usePanel(), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_1?m=msg_1&panel=a&panel=b"),
    })
    const url = result.current.getPanelUrl("x", { target: "a" })
    const search = new URLSearchParams(url.split("?")[1])
    expect(search.getAll("panel")).toEqual(["x", "b"])
    expect(search.get("m")).toBe("msg_1")
  })
})
