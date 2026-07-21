import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useResizeDrag } from "./use-resize-drag"

function ResizeHarness({
  onWidthChange,
  onResizeEnd,
  direction = "right",
}: {
  onWidthChange: (width: number) => void
  onResizeEnd: (width: number) => void
  direction?: "right" | "left"
}) {
  const resize = useResizeDrag({ width: 250, onWidthChange, onResizeEnd, direction })
  return (
    <div
      data-testid="handle"
      data-resizing={resize.isResizing}
      onPointerDown={resize.handleResizeStart}
      onPointerMove={resize.handleResizeMove}
      onPointerUp={resize.handleResizeEnd}
      onPointerCancel={resize.handleResizeEnd}
    />
  )
}

describe("useResizeDrag", () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  const setPointerCapture = vi.fn()

  beforeEach(() => {
    frames.clear()
    nextFrame = 1
    setPointerCapture.mockClear()
    HTMLElement.prototype.setPointerCapture = setPointerCapture
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrame++
        frames.set(id, callback)
        return id
      })
    )
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => {
        frames.delete(id)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("captures the pointer, coalesces moves, and commits the final width", () => {
    const onWidthChange = vi.fn()
    const onResizeEnd = vi.fn()
    render(<ResizeHarness onWidthChange={onWidthChange} onResizeEnd={onResizeEnd} />)
    const handle = screen.getByTestId("handle")

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 100 })
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(handle).toHaveAttribute("data-resizing", "true")

    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 120 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 145 })
    expect(onWidthChange).not.toHaveBeenCalled()

    act(() => frames.values().next().value?.(0))
    expect(onWidthChange).toHaveBeenCalledTimes(1)
    expect(onWidthChange).toHaveBeenLastCalledWith(295)

    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 160 })
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 160 })

    expect(onWidthChange).toHaveBeenLastCalledWith(310)
    expect(onResizeEnd).toHaveBeenCalledWith(310)
    expect(handle).toHaveAttribute("data-resizing", "false")
  })

  it("reverses the drag delta for a right-side panel", () => {
    const onWidthChange = vi.fn()
    const onResizeEnd = vi.fn()
    render(<ResizeHarness direction="left" onWidthChange={onWidthChange} onResizeEnd={onResizeEnd} />)
    const handle = screen.getByTestId("handle")

    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 300 })
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 260 })
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 260 })

    expect(onResizeEnd).toHaveBeenCalledWith(290)
  })
})
