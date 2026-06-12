import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { ReactNode } from "react"
import * as Contexts from "@/contexts"
import { usePanelAwareLink } from "./use-panel-aware-nav"

function stubSidebar(isMobile: boolean) {
  vi.spyOn(Contexts, "useSidebar").mockReturnValue({ isMobile } as unknown as ReturnType<typeof Contexts.useSidebar>)
}

function wrapperWithUrl(url: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/w/:workspaceId/*" element={<Contexts.PanelProvider>{children}</Contexts.PanelProvider>} />
        </Routes>
      </MemoryRouter>
    )
  }
}

/** The link hook plus the panel context, so tests can arrange focus and observe opens. */
function useHarness(targetPath: string, panelId: string) {
  return { link: usePanelAwareLink(targetPath, panelId), panel: Contexts.usePanel() }
}

function clickEvent(init: { meta?: boolean } = {}) {
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn()
  return {
    event: {
      metaKey: init.meta ?? false,
      ctrlKey: false,
      preventDefault,
      stopPropagation,
    } as unknown as React.MouseEvent,
    preventDefault,
  }
}

describe("usePanelAwareLink", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.innerWidth = 2200
  })

  it("plain click opens the target in the focused side panel", () => {
    stubSidebar(false)
    const { result } = renderHook(() => useHarness("/w/ws_1/s/stream_x", "stream_x"), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_main?panel=a&panel=b"),
    })
    act(() => result.current.panel.setFocusedPane("a"))
    const { event, preventDefault } = clickEvent()
    act(() => result.current.link.onClick(event))
    expect(preventDefault).toHaveBeenCalled()
    expect(result.current.panel.panels).toEqual(["stream_x", "b"])
  })

  it("plain click with the main pane focused falls through to navigation", () => {
    stubSidebar(false)
    const { result } = renderHook(() => useHarness("/w/ws_1/s/stream_x", "stream_x"), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_main?panel=a"),
    })
    act(() => result.current.panel.setFocusedPane("main"))
    const { event, preventDefault } = clickEvent()
    act(() => result.current.link.onClick(event))
    expect(preventDefault).not.toHaveBeenCalled()
    expect(result.current.panel.panels).toEqual(["a"])
  })

  it("plain click on a target already open in a panel focuses that panel", () => {
    stubSidebar(false)
    const { result } = renderHook(() => useHarness("/w/ws_1/s/b", "b"), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_main?panel=a&panel=b"),
    })
    act(() => result.current.panel.setFocusedPane("a"))
    const { event, preventDefault } = clickEvent()
    act(() => result.current.link.onClick(event))
    expect(preventDefault).toHaveBeenCalled()
    expect(result.current.panel.panels).toEqual(["a", "b"])
    expect(result.current.panel.getFocusedPane()).toBe("b")
  })

  it("plain click on the pane-0 target focuses the main pane", () => {
    stubSidebar(false)
    const { result } = renderHook(() => useHarness("/w/ws_1/s/stream_main", "stream_main"), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_main?panel=a"),
    })
    act(() => result.current.panel.setFocusedPane("a"))
    const { event, preventDefault } = clickEvent()
    act(() => result.current.link.onClick(event))
    expect(preventDefault).toHaveBeenCalled()
    expect(result.current.panel.getFocusedPane()).toBe("main")
  })

  it("leaves modifier clicks alone — the global PanelCmdClickHandler owns that gesture", () => {
    stubSidebar(false)
    const { result } = renderHook(() => useHarness("/w/ws_1/s/stream_x", "stream_x"), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_main?panel=a"),
    })
    act(() => result.current.panel.setFocusedPane("a"))
    const { event, preventDefault } = clickEvent({ meta: true })
    act(() => result.current.link.onClick(event))
    expect(preventDefault).not.toHaveBeenCalled()
    expect(result.current.panel.panels).toEqual(["a"])
  })

  it("on mobile, plain click always falls through to navigation", () => {
    stubSidebar(true)
    const { result } = renderHook(() => useHarness("/w/ws_1/s/stream_x", "stream_x"), {
      wrapper: wrapperWithUrl("/w/ws_1/s/stream_main?panel=a"),
    })
    act(() => result.current.panel.setFocusedPane("a"))
    const { event, preventDefault } = clickEvent()
    act(() => result.current.link.onClick(event))
    expect(preventDefault).not.toHaveBeenCalled()
    expect(result.current.panel.panels).toEqual(["a"])
  })
})
