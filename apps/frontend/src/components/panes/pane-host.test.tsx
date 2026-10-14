import { afterEach, describe, it, expect } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { createRef } from "react"
import { Pane, PaneHost, PaneLanded, usePaneCovered } from "./pane-host"

function CoveredProbe() {
  return <span data-testid="probe">{String(usePaneCovered())}</span>
}

function LandedProbe() {
  return (
    <span data-testid="landed">
      <PaneLanded fallback="false">true</PaneLanded>
    </span>
  )
}

describe("Pane", () => {
  it("should hide a covered pane with visibility and make it inert when another pane covers it", () => {
    render(<Pane area="1 / 1" covered data-testid="pane" />)
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
    render(<Pane area="1 / 2" data-testid="pane" />)
    const pane = screen.getByTestId("pane")
    expect({ invisible: pane.classList.contains("invisible"), inert: pane.hasAttribute("inert") }).toEqual({
      invisible: false,
      inert: false,
    })
  })

  it("should report a pane as covered when a pane around it is covered", () => {
    render(
      <Pane area="1 / 1" covered>
        <Pane area="1 / 1">
          <CoveredProbe />
        </Pane>
      </Pane>
    )
    expect(screen.getByTestId("probe").textContent).toBe("true")
  })

  it("should report a pane as on screen when nothing around it is covered", () => {
    render(
      <Pane area="1 / 1">
        <CoveredProbe />
      </Pane>
    )
    expect(screen.getByTestId("probe").textContent).toBe("false")
  })
})

describe("Pane landing", () => {
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations
  })

  function renderHost(glide: boolean) {
    return render(
      <PaneHost columns="1fr" rows="1fr" glide={glide} reshapes={glide} ref={createRef<HTMLDivElement>()}>
        <Pane area="1 / 1" data-panel-tab="stream_a">
          <LandedProbe />
        </Pane>
      </PaneHost>
    )
  }

  it("should hold a pane's content until the glide that brought it in has landed", async () => {
    let land!: () => void
    const finished = new Promise<void>((resolve) => (land = resolve))
    let gliding = true
    HTMLElement.prototype.getAnimations = function () {
      return gliding ? [{ id: "pane-glide", finished } as unknown as Animation] : []
    }
    renderHost(true)
    expect(screen.getByTestId("landed").textContent).toBe("false")

    gliding = false
    await act(async () => land())
    expect(screen.getByTestId("landed").textContent).toBe("true")
  })

  it("should show a pane's content once the host finds nothing gliding", async () => {
    HTMLElement.prototype.getAnimations = () => []
    renderHost(true)
    await act(async () => {})
    expect(screen.getByTestId("landed").textContent).toBe("true")
  })

  it("should show a pane's content at once when its arrangement keeps its shape", () => {
    renderHost(false)
    expect(screen.getByTestId("landed").textContent).toBe("true")
  })
})
