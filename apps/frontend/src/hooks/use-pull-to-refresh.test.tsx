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
  it("ignores gestures that start inside a suppressed subtree", () => {
    render(<Harness />)
    const plain = screen.getByTestId("plain")
    fireEvent.touchStart(plain, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(plain, { touches: [{ clientY: 200 }] })
    expect(screen.getByRole("status")).toHaveTextContent("40")
    fireEvent.touchEnd(plain)

    const suppressed = screen.getByTestId("suppressed")
    fireEvent.touchStart(suppressed, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(suppressed, { touches: [{ clientY: 400 }] })
    expect(screen.getByRole("status")).toHaveTextContent("0")
  })
})
