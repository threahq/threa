import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { usePullToRefresh } from "./use-pull-to-refresh"

function Harness() {
  const { ref, distance } = usePullToRefresh({ enabled: true })
  return (
    <div ref={ref}>
      <div data-testid="plain" />
      <div data-suppress-pull-refresh>
        <div data-testid="suppressed" />
      </div>
      <output>{distance}</output>
    </div>
  )
}

describe("usePullToRefresh", () => {
  it("tracks gestures that start outside a suppressed subtree", () => {
    render(<Harness />)
    const plain = screen.getByTestId("plain")
    fireEvent.touchStart(plain, { touches: [{ clientY: 100 }] })

    expect(fireEvent.touchMove(plain, { touches: [{ clientY: 200 }] })).toBe(false)
    expect(screen.getByRole("status")).toHaveTextContent("40")
  })

  it("ignores gestures that start inside a suppressed subtree", () => {
    render(<Harness />)
    const suppressed = screen.getByTestId("suppressed")
    fireEvent.touchStart(suppressed, { touches: [{ clientY: 100 }] })

    expect(fireEvent.touchMove(suppressed, { touches: [{ clientY: 400 }] })).toBe(true)
    expect(screen.getByRole("status")).toHaveTextContent("0")
  })
})
