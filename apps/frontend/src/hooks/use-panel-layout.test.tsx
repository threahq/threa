import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { usePanelLayout } from "./use-panel-layout"

function pointerEvent(type: "pointerdown" | "pointerup"): React.PointerEvent {
  return {
    type,
    pointerId: 1,
    clientX: 100,
    isPrimary: true,
    button: 0,
    currentTarget: { setPointerCapture: vi.fn() },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.PointerEvent
}

describe("usePanelLayout", () => {
  it("keeps captured resize content mounted until a mid-drag close settles", () => {
    const { result, rerender } = renderHook(({ open }) => usePanelLayout(open), {
      initialProps: { open: true },
    })

    act(() => result.current.handleResizeStart(pointerEvent("pointerdown")))
    rerender({ open: false })

    expect({ isResizing: result.current.isResizing, showContent: result.current.showContent }).toEqual({
      isResizing: true,
      showContent: true,
    })

    act(() => result.current.handleResizeEnd(pointerEvent("pointerup")))

    expect({ isResizing: result.current.isResizing, showContent: result.current.showContent }).toEqual({
      isResizing: false,
      showContent: false,
    })
  })

  it("should keep content until the host's own track transition ends when a close animates", async () => {
    const { result, rerender } = renderHook(({ open }) => usePanelLayout(open), { initialProps: { open: true } })
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    rerender({ open: false })

    const host = {}
    act(() => result.current.handleTransitionEnd(transitionEnd("grid-template-columns", {}, host)))
    expect(result.current.showContent).toBe(true)

    act(() => result.current.handleTransitionEnd(transitionEnd("grid-template-columns", host, host)))
    expect(result.current.showContent).toBe(false)
  })

  it("should drop content at once when a close cannot animate", async () => {
    const { result, rerender } = renderHook(({ open }) => usePanelLayout(open, { animates: false }), {
      initialProps: { open: true },
    })
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    rerender({ open: false })

    expect(result.current.showContent).toBe(false)
  })
})

function transitionEnd(propertyName: string, target: object, currentTarget: object): React.TransitionEvent {
  return { propertyName, target, currentTarget } as unknown as React.TransitionEvent
}
