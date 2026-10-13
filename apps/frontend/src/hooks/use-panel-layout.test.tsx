import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { usePanelLayout } from "./use-panel-layout"

describe("usePanelLayout", () => {
  it("should open at the default width when a panel sized before it closed opens again", () => {
    const { result, rerender } = renderHook(({ open }) => usePanelLayout(open), { initialProps: { open: true } })
    act(() => result.current.sizePanel(700, 1))
    expect(result.current.panelWidth).toBe(700)

    rerender({ open: false })
    rerender({ open: true })
    expect(result.current.panelWidth).toBe(480)
  })
})
