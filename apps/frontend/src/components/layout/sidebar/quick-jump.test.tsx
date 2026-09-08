import { act } from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, useLocation } from "react-router-dom"
import * as contextsModule from "@/contexts"
import { QuickJumpCap, SidebarQuickJumpProvider, createQuickJumpCollector, useQuickJumpSlot } from "./quick-jump"

const mockPreferences = {
  keyboardShortcuts: {} as Record<string, string>,
}

function Row({ streamId }: { streamId: string }) {
  const quickJump = useQuickJumpSlot(streamId)
  return (
    <div data-testid={`row-${streamId}`} data-keyshortcuts={quickJump?.keyshortcut ?? ""}>
      {quickJump ? <QuickJumpCap slot={quickJump.slot} /> : null}
    </div>
  )
}

function PathEcho() {
  return <div data-testid="path">{useLocation().pathname}</div>
}

function renderSidebar(order: string[]) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_start"]}>
      <SidebarQuickJumpProvider workspaceId="ws_1" order={order}>
        {order.map((id) => (
          <Row key={id} streamId={id} />
        ))}
      </SidebarQuickJumpProvider>
      <PathEcho />
    </MemoryRouter>
  )
}

function capOf(streamId: string): string {
  return screen.getByTestId(`row-${streamId}`).textContent ?? ""
}

function holdModifier() {
  fireEvent.keyDown(document, { key: "Control", ctrlKey: true })
}

function reveal() {
  act(() => {
    vi.advanceTimersByTime(200)
  })
}

describe("SidebarQuickJumpProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockPreferences.keyboardShortcuts = {}
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: mockPreferences,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("numbers the rows in order once the modifier has been held", () => {
    renderSidebar(["stream_a", "stream_b", "stream_c"])

    expect(capOf("stream_a")).toBe("")

    holdModifier()
    reveal()

    expect([capOf("stream_a"), capOf("stream_b"), capOf("stream_c")]).toEqual(["1", "2", "3"])
    expect(screen.getByTestId("row-stream_b").dataset.keyshortcuts).toBe("Control+2")
  })

  it("does not number anything before the hold delay elapses", () => {
    renderSidebar(["stream_a", "stream_b"])

    holdModifier()

    expect(capOf("stream_a")).toBe("")
  })

  it("opens the numbered stream on a digit press", () => {
    renderSidebar(["stream_a", "stream_b", "stream_c"])

    holdModifier()
    reveal()
    fireEvent.keyDown(document, { key: "3", code: "Digit3", ctrlKey: true })

    expect(screen.getByTestId("path").textContent).toBe("/w/ws_1/s/stream_c")
    expect(capOf("stream_a")).toBe("")
  })

  it("opens a stream when the digit beats the reveal delay", () => {
    renderSidebar(["stream_a", "stream_b"])

    holdModifier()
    fireEvent.keyDown(document, { key: "2", code: "Digit2", ctrlKey: true })

    expect(screen.getByTestId("path").textContent).toBe("/w/ws_1/s/stream_b")
  })

  it("freezes the mapping at the moment the modifier goes down", () => {
    const { rerender } = renderSidebar(["stream_a", "stream_b"])

    holdModifier()
    reveal()

    // A message lands mid-hold and re-sorts the list.
    const reordered = ["stream_b", "stream_a"]
    rerender(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_start"]}>
        <SidebarQuickJumpProvider workspaceId="ws_1" order={reordered}>
          {reordered.map((id) => (
            <Row key={id} streamId={id} />
          ))}
        </SidebarQuickJumpProvider>
        <PathEcho />
      </MemoryRouter>
    )

    expect(capOf("stream_a")).toBe("1")
    fireEvent.keyDown(document, { key: "1", code: "Digit1", ctrlKey: true })
    expect(screen.getByTestId("path").textContent).toBe("/w/ws_1/s/stream_a")
  })

  it("ignores a digit with no stream in that slot", () => {
    renderSidebar(["stream_a"])

    holdModifier()
    fireEvent.keyDown(document, { key: "5", code: "Digit5", ctrlKey: true })

    expect(screen.getByTestId("path").textContent).toBe("/w/ws_1/s/stream_start")
  })

  it("cancels the reveal when the modifier drives a different shortcut", () => {
    renderSidebar(["stream_a"])

    holdModifier()
    fireEvent.keyDown(document, { key: "k", code: "KeyK", ctrlKey: true })
    reveal()

    expect(capOf("stream_a")).toBe("")
  })

  it("clears the numbers when the modifier is released", () => {
    renderSidebar(["stream_a"])

    holdModifier()
    reveal()
    expect(capOf("stream_a")).toBe("1")

    fireEvent.keyUp(document, { key: "Control", ctrlKey: false })

    expect(capOf("stream_a")).toBe("")
  })

  it("clears the numbers when the window loses focus mid-hold", () => {
    renderSidebar(["stream_a"])

    holdModifier()
    reveal()
    fireEvent.blur(window)

    expect(capOf("stream_a")).toBe("")
  })

  it("follows a rebound modifier and leaves the default one alone", () => {
    mockPreferences.keyboardShortcuts = { sidebarQuickJump: "alt+1" }
    renderSidebar(["stream_a", "stream_b"])

    holdModifier()
    reveal()
    expect(capOf("stream_a")).toBe("")

    fireEvent.keyDown(document, { key: "Alt", altKey: true })
    reveal()
    expect(screen.getByTestId("row-stream_a").dataset.keyshortcuts).toBe("Alt+1")

    // Mac rewrites the character under Alt; the physical key still resolves.
    fireEvent.keyDown(document, { key: "™", code: "Digit2", altKey: true })
    expect(screen.getByTestId("path").textContent).toBe("/w/ws_1/s/stream_b")
  })

  it("stays inert when the shortcut is disabled", () => {
    mockPreferences.keyboardShortcuts = { sidebarQuickJump: "none" }
    renderSidebar(["stream_a"])

    holdModifier()
    reveal()
    fireEvent.keyDown(document, { key: "1", code: "Digit1", ctrlKey: true })

    expect(capOf("stream_a")).toBe("")
    expect(screen.getByTestId("path").textContent).toBe("/w/ws_1/s/stream_start")
  })
})

describe("createQuickJumpCollector", () => {
  it("keeps the first nine ids and the first slot of a repeated stream", () => {
    const collector = createQuickJumpCollector()
    collector.add("stream_a")
    collector.add("stream_b")
    collector.add("stream_a")
    for (let i = 0; i < 20; i += 1) collector.add(`stream_${i}`)

    expect(collector.ids).toHaveLength(9)
    expect(collector.ids.slice(0, 3)).toEqual(["stream_a", "stream_b", "stream_0"])
  })
})
