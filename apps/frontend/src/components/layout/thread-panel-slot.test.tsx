import type { ComponentProps } from "react"
import { describe, it, expect, beforeEach } from "vitest"
import { render, screen } from "@/test"
import { ThreadPanelSlot } from "./thread-panel-slot"

function noop() {}

const baseProps = {
  displayWidth: 420,
  panelWidth: 420,
  shouldAnimate: false,
  showContent: true,
  isResizing: false,
  minWidth: 280,
  maxWidth: 640,
  onTransitionEnd: noop,
  onResizeStart: noop,
  onResizeMove: noop,
  onResizeEnd: noop,
  onResizeKeyDown: noop,
}

function renderSlot(overrides: Partial<ComponentProps<typeof ThreadPanelSlot>> = {}) {
  return render(
    <ThreadPanelSlot
      displayWidth={420}
      panelWidth={420}
      shouldAnimate={false}
      showContent
      isResizing={false}
      minWidth={280}
      maxWidth={640}
      onTransitionEnd={noop}
      onResizeStart={noop}
      onResizeMove={noop}
      onResizeEnd={noop}
      onResizeKeyDown={noop}
      {...overrides}
    >
      <div data-testid="panel-content" />
    </ThreadPanelSlot>
  )
}

function inset() {
  const style = document.documentElement.style
  return {
    right: style.getPropertyValue("--panel-inset-right"),
    duration: style.getPropertyValue("--panel-inset-duration"),
  }
}

describe("ThreadPanelSlot — panel inset vars", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style")
  })

  it("publishes the open panel's width with no duration while it isn't animating", () => {
    renderSlot()
    expect(screen.getByTestId("panel-content")).toBeInTheDocument()
    expect(inset()).toEqual({ right: "420px", duration: "0ms" })
  })

  it("publishes 0px for a closed panel", () => {
    renderSlot({ displayWidth: 0, showContent: false })
    expect(inset()).toEqual({ right: "0px", duration: "0ms" })
  })

  it("publishes the open/close animation duration while the slot animates", () => {
    const { rerender } = renderSlot({ shouldAnimate: true })
    expect(inset()).toEqual({ right: "420px", duration: "200ms" })

    // Dragging the resize handle drops shouldAnimate, so a consumer's edge tracks
    // the drag instead of lagging a transition behind it.
    rerender(
      <ThreadPanelSlot
        displayWidth={500}
        panelWidth={500}
        shouldAnimate={false}
        showContent
        isResizing
        minWidth={280}
        maxWidth={640}
        onTransitionEnd={noop}
        onResizeStart={noop}
        onResizeMove={noop}
        onResizeEnd={noop}
        onResizeKeyDown={noop}
      >
        <div data-testid="panel-content" />
      </ThreadPanelSlot>
    )
    expect(inset()).toEqual({ right: "500px", duration: "0ms" })
  })

  it("resets the inset when the slot unmounts", () => {
    const { unmount } = renderSlot({ shouldAnimate: true })
    unmount()
    expect(inset()).toEqual({ right: "0px", duration: "0ms" })
  })
})

describe("ThreadPanelSlot — instance swap", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style")
  })

  it("keeps the incoming slot's inset when routes swap one instance for another in a commit", () => {
    // stream.tsx / board.tsx / persona-editor.tsx each mount their own slot, so
    // navigating between two of them with a panel open on both unmounts one and
    // mounts the other in the SAME commit. The consumer (the fullscreen call
    // overlay) outlives the route, so a teardown that lands after the new mount
    // leaves it reading 0px over an open panel.
    const { rerender } = render(
      <ThreadPanelSlot key="from" {...baseProps} displayWidth={420} panelWidth={420}>
        <div data-testid="panel-content" />
      </ThreadPanelSlot>
    )
    expect(inset()).toEqual({ right: "420px", duration: "0ms" })

    rerender(
      <ThreadPanelSlot key="to" {...baseProps} displayWidth={360} panelWidth={360}>
        <div data-testid="panel-content" />
      </ThreadPanelSlot>
    )
    expect(inset()).toEqual({ right: "360px", duration: "0ms" })
  })
})
