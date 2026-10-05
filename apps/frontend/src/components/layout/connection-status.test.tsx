import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { act } from "@testing-library/react"
import { render, screen } from "@/test"
import { ConnectionStatus } from "./connection-status"
import * as contextsModule from "@/contexts"
import * as pageActivityModule from "@/hooks/use-page-activity"

const mockState = {
  phase: "ready" as "loading" | "skeleton" | "ready",
  socketStatus: "connected" as "connected" | "connecting" | "reconnecting" | "disconnected",
  online: true,
  visible: true,
}

describe("ConnectionStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockState.phase = "ready"
    mockState.socketStatus = "connected"
    mockState.online = true
    mockState.visible = true
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    })
    vi.spyOn(contextsModule, "useCoordinatedLoading").mockImplementation((select) =>
      select({ phase: mockState.phase } as Parameters<typeof select>[0])
    )
    vi.spyOn(contextsModule, "useSocketStatus").mockImplementation(
      () => mockState.socketStatus as unknown as ReturnType<typeof contextsModule.useSocketStatus>
    )
    vi.spyOn(pageActivityModule, "usePageActivity").mockImplementation(
      () =>
        ({
          isVisible: mockState.visible,
          isFocused: true,
          isActive: mockState.visible,
        }) as unknown as ReturnType<typeof pageActivityModule.usePageActivity>
    )
  })

  it("does not render during the initial coordinated load", () => {
    mockState.phase = "loading"
    mockState.socketStatus = "disconnected"

    const { container } = render(<ConnectionStatus />)

    expect(container).toBeEmptyDOMElement()
  })

  it("does not render while the socket is still connecting", () => {
    mockState.socketStatus = "connecting"

    const { container } = render(<ConnectionStatus />)

    expect(container).toBeEmptyDOMElement()
  })

  it("does not render the pill immediately when the connection goes unstable", () => {
    mockState.socketStatus = "disconnected"
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    })

    const { container } = render(<ConnectionStatus />)

    expect(container).toBeEmptyDOMElement()
  })

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("renders the offline pill once the unstable state has persisted", () => {
      mockState.socketStatus = "disconnected"
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        value: false,
      })

      render(<ConnectionStatus />)
      expect(screen.queryByText("Offline")).not.toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(3000)
      })

      expect(screen.getByText("Offline")).toBeInTheDocument()
    })

    it("does not re-arm the delay when flipping between unstable subtypes", () => {
      mockState.socketStatus = "reconnecting"
      const { rerender } = render(<ConnectionStatus />)

      act(() => {
        vi.advanceTimersByTime(2000)
      })

      mockState.socketStatus = "disconnected"
      rerender(<ConnectionStatus />)

      act(() => {
        vi.advanceTimersByTime(1500)
      })

      expect(screen.getByText("Disconnected")).toBeInTheDocument()
    })
  })

  it("does not render when the page is hidden during teardown", () => {
    mockState.socketStatus = "reconnecting"
    mockState.visible = false

    const { container } = render(<ConnectionStatus />)

    expect(container).toBeEmptyDOMElement()
  })
})
