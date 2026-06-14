import { describe, it, expect, vi } from "vitest"
import { keepEditorFocusProps } from "./keep-editor-focus"

/** Build a mousedown-like event whose target/currentTarget we control. */
function mouseEvent(target: Element, currentTarget: Element) {
  return {
    target,
    currentTarget,
    preventDefault: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>
}

describe("keepEditorFocusProps", () => {
  it("returns no handlers when disabled so Radix keeps managing focus", () => {
    expect(keepEditorFocusProps(false)).toEqual({})
  })

  it("prevents Radix auto-focus on open and close when enabled", () => {
    const props = keepEditorFocusProps(true)
    const openEvent = { preventDefault: vi.fn() } as unknown as Event
    const closeEvent = { preventDefault: vi.fn() } as unknown as Event

    props.onOpenAutoFocus?.(openEvent)
    props.onCloseAutoFocus?.(closeEvent)

    expect(openEvent.preventDefault).toHaveBeenCalledOnce()
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
  })

  it("keeps editor focus when a button inside the popover is pressed", () => {
    const content = document.createElement("div")
    const button = document.createElement("button")
    content.appendChild(button)

    const event = mouseEvent(button, content)
    keepEditorFocusProps(true).onMouseDown?.(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it("lets native inputs take focus so their platform pickers open", () => {
    const content = document.createElement("div")
    const input = document.createElement("input")
    input.type = "date"
    content.appendChild(input)

    const event = mouseEvent(input, content)
    keepEditorFocusProps(true).onMouseDown?.(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it("ignores elements outside the popover (nested portaled menus)", () => {
    const content = document.createElement("div")
    const portaledItem = document.createElement("button")
    // Not appended to `content` — simulates a nested menu portaled to <body>
    // whose synthetic event still bubbles back through the React tree.

    const event = mouseEvent(portaledItem, content)
    keepEditorFocusProps(true).onMouseDown?.(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
