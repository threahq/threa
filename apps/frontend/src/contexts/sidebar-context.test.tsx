import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ReactNode } from "react"
import { SidebarProvider, useSidebar } from "./sidebar-context"

const SIDEBAR_STATE_KEY = "threa-sidebar-state"

function wrapper({ children }: { children: ReactNode }) {
  return <SidebarProvider>{children}</SidebarProvider>
}

describe("SidebarContext.togglePinned (desktop)", () => {
  it("locks a hover-preview sidebar as pinned instead of collapsing it", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    // Start from collapsed → hover opens preview
    act(() => result.current.collapse())
    act(() => result.current.setHovering(true))
    expect(result.current.state).toBe("preview")

    // While still hovering, toggling should LOCK it as pinned, not collapse
    act(() => result.current.togglePinned())
    expect(result.current.state).toBe("pinned")
  })

  it("collapses a pinned sidebar", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    // Force pinned first (default state from a fresh provider may be pinned,
    // but explicitly ensure it).
    if (result.current.state !== "pinned") {
      act(() => result.current.togglePinned())
    }
    expect(result.current.state).toBe("pinned")

    act(() => result.current.togglePinned())
    expect(result.current.state).toBe("collapsed")
  })

  it("expands a collapsed sidebar to pinned", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    act(() => result.current.collapse())
    expect(result.current.state).toBe("collapsed")

    act(() => result.current.togglePinned())
    expect(result.current.state).toBe("pinned")
  })
})

describe("SidebarContext.setWidth", () => {
  const viewportWidth = window.innerWidth

  beforeEach(() => {
    localStorage.removeItem(SIDEBAR_STATE_KEY)
    window.innerWidth = viewportWidth
  })

  it("clamps a non-collapsing resize to the minimum width", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    act(() => result.current.setWidth(175))

    expect({ state: result.current.state, width: result.current.width }).toEqual({
      state: "pinned",
      width: 200,
    })
  })

  it("collapses below the resize-to-minimize threshold", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    act(() => result.current.setWidth(149))

    expect(result.current.state).toBe("collapsed")
  })

  it("clamps to the 500px ceiling on a wide window", () => {
    window.innerWidth = 1600
    const { result } = renderHook(() => useSidebar(), { wrapper })

    act(() => result.current.setWidth(900))

    expect(result.current.width).toBe(500)
  })

  it("clamps to half the window when that is narrower than the ceiling", () => {
    window.innerWidth = 800
    const { result } = renderHook(() => useSidebar(), { wrapper })

    act(() => result.current.setWidth(900))

    expect(result.current.width).toBe(400)
  })
})

describe("SidebarContext.toggleSectionState", () => {
  beforeEach(() => {
    localStorage.removeItem(SIDEBAR_STATE_KEY)
  })

  it("quick-links defaults to open", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })
    expect(result.current.getSectionState("quick-links", "open")).toBe("open")
  })

  it("other section defaults to collapsed", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })
    expect(result.current.getSectionState("other", "collapsed")).toBe("collapsed")
  })

  it("unknown sections fall back to the provided default", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })
    expect(result.current.getSectionState("channels")).toBe("open")
    expect(result.current.getSectionState("channels:rest", "collapsed")).toBe("collapsed")
  })

  it("flips a section between open and collapsed", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    expect(result.current.getSectionState("quick-links")).toBe("open")

    act(() => result.current.toggleSectionState("quick-links"))
    expect(result.current.getSectionState("quick-links")).toBe("collapsed")

    act(() => result.current.toggleSectionState("quick-links"))
    expect(result.current.getSectionState("quick-links")).toBe("open")
  })

  it("toggles an unknown section starting from its provided default", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    act(() => result.current.toggleSectionState("channels:rest", "collapsed"))
    expect(result.current.getSectionState("channels:rest", "collapsed")).toBe("open")
  })

  it("persists section states to localStorage", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    act(() => result.current.toggleSectionState("quick-links"))

    const raw = localStorage.getItem(SIDEBAR_STATE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string)
    expect(parsed.sectionStates["quick-links"]).toBe("collapsed")
  })

  it("persists nested subsection states alongside parent sections", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })

    act(() => result.current.toggleSectionState("channels:rest", "collapsed"))
    act(() => result.current.toggleSectionState("other:rest", "collapsed"))

    const raw = localStorage.getItem(SIDEBAR_STATE_KEY)
    const parsed = JSON.parse(raw as string)
    expect(parsed.sectionStates["channels:rest"]).toBe("open")
    expect(parsed.sectionStates["other:rest"]).toBe("open")
  })

  it("rehydrates nested subsection states across provider remounts", () => {
    const first = renderHook(() => useSidebar(), { wrapper })
    act(() => first.result.current.toggleSectionState("scratchpads:rest", "collapsed"))
    first.unmount()

    const second = renderHook(() => useSidebar(), { wrapper })
    expect(second.result.current.getSectionState("scratchpads:rest", "collapsed")).toBe("open")
  })

  it("migrates legacy collapsedSections into sectionStates", () => {
    localStorage.setItem(
      SIDEBAR_STATE_KEY,
      JSON.stringify({
        openState: "open",
        width: 260,
        viewMode: "smart",
        collapsedSections: ["channels", "dms"],
      })
    )

    const { result } = renderHook(() => useSidebar(), { wrapper })
    expect(result.current.getSectionState("channels")).toBe("collapsed")
    expect(result.current.getSectionState("dms")).toBe("collapsed")
  })

  it("migrates legacy quickLinksState into sectionStates['quick-links']", () => {
    localStorage.setItem(
      SIDEBAR_STATE_KEY,
      JSON.stringify({
        openState: "open",
        width: 260,
        viewMode: "smart",
        quickLinksState: "open",
      })
    )

    const { result } = renderHook(() => useSidebar(), { wrapper })
    expect(result.current.getSectionState("quick-links")).toBe("open")
  })

  it("migrates legacy 'auto' values to 'open'", () => {
    localStorage.setItem(
      SIDEBAR_STATE_KEY,
      JSON.stringify({
        openState: "open",
        width: 260,
        viewMode: "smart",
        sectionStates: { "quick-links": "auto", channels: "auto", other: "collapsed" },
      })
    )

    const { result } = renderHook(() => useSidebar(), { wrapper })
    expect(result.current.getSectionState("quick-links")).toBe("open")
    expect(result.current.getSectionState("channels")).toBe("open")
    expect(result.current.getSectionState("other")).toBe("collapsed")
  })

  it("ignores invalid persisted values", () => {
    localStorage.setItem(
      SIDEBAR_STATE_KEY,
      JSON.stringify({
        openState: "open",
        width: 260,
        viewMode: "smart",
        sectionStates: { "quick-links": "nonsense", channels: "collapsed" },
      })
    )

    const { result } = renderHook(() => useSidebar(), { wrapper })
    expect(result.current.getSectionState("quick-links")).toBe("open")
    expect(result.current.getSectionState("channels")).toBe("collapsed")
  })
})
