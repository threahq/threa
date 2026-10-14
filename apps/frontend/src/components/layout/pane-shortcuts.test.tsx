import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { landFocus } from "./pane-shortcuts"

function frames(count: number) {
  for (let i = 0; i < count; i += 1) vi.advanceTimersByTime(16)
}

/** jsdom gives every element an empty box; the editor needs one inside the viewport. */
function mountEditor(pane: HTMLElement) {
  const editor = document.createElement("div")
  editor.setAttribute("contenteditable", "true")
  editor.tabIndex = 0
  Object.defineProperty(editor, "getClientRects", { value: () => [{ width: 10, height: 10 }] })
  Object.defineProperty(editor, "getBoundingClientRect", {
    value: () => ({ top: 100, bottom: 140, left: 0, right: 300 }),
  })
  pane.appendChild(editor)
  return editor
}

describe("landFocus", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div data-panel-tab="stream_a"><a href="#a" aria-current="page" id="tab">tab</a></div>'
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("should wait out the glide bringing the pane in, then land in the composer it mounts", () => {
    const pane = document.querySelector<HTMLElement>("[data-panel-tab]")!
    pane.setAttribute("data-pane-gliding", "")
    landFocus({ current: 0 }, "stream_a")
    frames(20)
    expect(document.activeElement).toBe(document.body)

    pane.removeAttribute("data-pane-gliding")
    frames(3)
    const editor = mountEditor(pane)
    frames(2)
    expect(document.activeElement).toBe(editor)
  })

  it("should land on the tab when the pane on show mounts no composer", () => {
    landFocus({ current: 0 }, "stream_a")
    frames(12)
    expect(document.activeElement?.id).toBe("tab")
  })
})
