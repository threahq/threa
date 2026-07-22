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
})
