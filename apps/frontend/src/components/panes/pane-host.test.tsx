import { afterEach, describe, it, expect } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { createRef } from "react"
import { useRevealReady } from "@/contexts"
import { Pane, PaneHost, PaneLanded, usePaneCovered } from "./pane-host"

function CoveredProbe() {
  return <span data-testid="probe">{String(usePaneCovered())}</span>
}

function Content({ ready }: { ready: boolean }) {
  useRevealReady(ready)
  return <span data-testid="content">content</span>
}

function LandedProbe({ ready, mount }: { ready: boolean; mount: string }) {
  return (
    <PaneLanded fallback={<span data-testid="fallback">fallback</span>}>
      <Content key={mount} ready={ready} />
    </PaneLanded>
  )
}

function shown() {
  return {
    content: screen.queryByTestId("content")?.parentElement?.className.includes("opacity-0") === false,
    fallback: screen.queryByTestId("fallback") !== null,
  }
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

  function host(glide: boolean, ready: boolean, mount = "first") {
    return (
      <PaneHost columns="1fr" rows="1fr" glide={glide} reshapes={glide} ref={createRef<HTMLDivElement>()}>
        <Pane area="1 / 1" data-panel-tab="stream_a" data-pane-gliding="">
          <LandedProbe ready={ready} mount={mount} />
        </Pane>
      </PaneHost>
    )
  }

  it("should hold a pane's content under the fallback until the glide lands and the content is ready", async () => {
    let land!: () => void
    const finished = new Promise<void>((resolve) => (land = resolve))
    let gliding = true
    HTMLElement.prototype.getAnimations = function () {
      return gliding ? [{ id: "pane-glide", finished } as unknown as Animation] : []
    }
    const { rerender } = render(host(true, false))
    await act(async () => {})
    expect({ mounted: screen.queryByTestId("content") !== null, ...shown() }).toEqual({
      mounted: false,
      content: false,
      fallback: true,
    })

    gliding = false
    await act(async () => land())
    expect({ mounted: screen.queryByTestId("content") !== null, ...shown() }).toEqual({
      mounted: true,
      content: false,
      fallback: true,
    })

    rerender(host(true, true))
    expect(shown()).toEqual({ content: true, fallback: false })
  })

  it("should show a revealed pane's content at once when it remounts", async () => {
    let land!: () => void
    const finished = new Promise<void>((resolve) => (land = resolve))
    HTMLElement.prototype.getAnimations = () => [{ id: "pane-glide", finished } as unknown as Animation]
    const { rerender } = render(host(true, false))
    await act(async () => {})
    HTMLElement.prototype.getAnimations = () => []
    await act(async () => land())
    rerender(host(true, true))

    rerender(host(true, false, "second"))
    expect(shown()).toEqual({ content: true, fallback: false })
  })

  it("should show a pane's content at once when the host finds nothing gliding", async () => {
    HTMLElement.prototype.getAnimations = () => []
    render(host(true, false))
    await act(async () => {})
    expect(shown()).toEqual({ content: true, fallback: false })
  })

  it("should show a pane's content at once when its arrangement keeps its shape", () => {
    render(host(false, false))
    expect(shown()).toEqual({ content: true, fallback: false })
  })
})
