import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Pane, usePaneCovered } from "./pane-host"

function CoveredProbe() {
  return <span data-testid="probe">{String(usePaneCovered())}</span>
}

describe("Pane", () => {
  it("should hide a covered pane with visibility and make it inert when another pane covers it", () => {
    render(<Pane column={1} covered data-testid="pane" />)
    const pane = screen.getByTestId("pane")
    // Tailwind's `hidden` is `display: none`, which destroys the scroller's box
    // and its offset — a covered pane must keep both.
    expect({ classes: pane.className.split(" "), inert: pane.hasAttribute("inert") }).toEqual({
      classes: expect.arrayContaining(["invisible"]),
      inert: true,
    })
    expect(pane.className.split(" ")).not.toContain("hidden")
  })

  it("should leave an uncovered pane visible and reachable when nothing covers it", () => {
    render(<Pane column={2} data-testid="pane" />)
    const pane = screen.getByTestId("pane")
    expect({ invisible: pane.classList.contains("invisible"), inert: pane.hasAttribute("inert") }).toEqual({
      invisible: false,
      inert: false,
    })
  })

  it("should report a pane as covered when a pane around it is covered", () => {
    render(
      <Pane column={1} covered>
        <Pane column={1}>
          <CoveredProbe />
        </Pane>
      </Pane>
    )
    expect(screen.getByTestId("probe").textContent).toBe("true")
  })

  it("should report a pane as on screen when nothing around it is covered", () => {
    render(
      <Pane column={1}>
        <CoveredProbe />
      </Pane>
    )
    expect(screen.getByTestId("probe").textContent).toBe("false")
  })
})
