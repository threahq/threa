import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { render } from "@testing-library/react"
import { useTypeToFocus } from "./use-type-to-focus"

function Harness() {
  useTypeToFocus()
  return null
}

/** Zones + editors are page furniture here; the hook only reads the DOM. */
function buildDom(html: string) {
  document.body.innerHTML = html
}

function press(key: string, init: KeyboardEventInit = {}) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }))
}

/**
 * jsdom reports no client rects and an all-zero bounding box for everything;
 * opt elements in explicitly, with a box inside the viewport.
 */
function setVisible(el: Element, visible: boolean) {
  Object.defineProperty(el, "getClientRects", {
    configurable: true,
    value: () => (visible ? [{ width: 10, height: 10 }] : []),
  })
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => (visible ? { top: 100, bottom: 140, left: 0, right: 300 } : { top: 0, bottom: 0, left: 0, right: 0 }),
  })
}

/** Rendered, but scrolled far below the viewport (an open card further down the feed). */
function setScrolledOffScreen(el: Element) {
  Object.defineProperty(el, "getClientRects", {
    configurable: true,
    value: () => [{ width: 10, height: 10 }],
  })
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: window.innerHeight + 500,
      bottom: window.innerHeight + 540,
      left: 0,
      right: 300,
    }),
  })
}

let unmount: () => void

beforeEach(() => {
  document.body.innerHTML = ""
  unmount = render(<Harness />).unmount
})

afterEach(() => {
  unmount()
  document.body.innerHTML = ""
})

function editors() {
  return Array.from(document.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
}

describe("useTypeToFocus", () => {
  it("a printable key focuses the zone's editor", () => {
    buildDom('<main data-editor-zone="main"><div contenteditable="true"></div></main>')
    const [editor] = editors()
    setVisible(editor, true)

    press("a")

    expect(document.activeElement).toBe(editor)
  })

  it("ignores modifier chords and non-printable keys", () => {
    buildDom('<main data-editor-zone="main"><div contenteditable="true"></div></main>')
    const [editor] = editors()
    setVisible(editor, true)

    press("a", { metaKey: true })
    press("k", { ctrlKey: true })
    press("Escape")
    press("ArrowDown")

    expect(document.activeElement).not.toBe(editor)
  })

  it("bails while an input already has focus", () => {
    buildDom('<input id="q" /><main data-editor-zone="main"><div contenteditable="true"></div></main>')
    const [editor] = editors()
    setVisible(editor, true)
    const input = document.getElementById("q") as HTMLInputElement
    input.focus()

    press("a")

    expect(document.activeElement).toBe(input)
  })

  it("bails mid-IME-composition", () => {
    buildDom('<main data-editor-zone="main"><div contenteditable="true"></div></main>')
    const [editor] = editors()
    setVisible(editor, true)

    press("a", { isComposing: true } as KeyboardEventInit)

    expect(document.activeElement).not.toBe(editor)
  })

  it("bails when another handler already claimed the key", () => {
    buildDom('<main data-editor-zone="main"><div contenteditable="true"></div></main>')
    const [editor] = editors()
    setVisible(editor, true)
    const claim = (e: Event) => e.preventDefault()
    // Capture phase so the claim lands before the hook's document listener,
    // exactly as an app-level shortcut handler does.
    document.addEventListener("keydown", claim, true)

    press("a")
    document.removeEventListener("keydown", claim, true)

    expect(document.activeElement).not.toBe(editor)
  })

  it("an open dialog with an editor takes the key; a dialog without one swallows it", () => {
    buildDom(
      '<div role="dialog" data-state="open"><div contenteditable="true" id="d"></div></div>' +
        '<main data-editor-zone="main"><div contenteditable="true" id="m"></div></main>'
    )
    const dialogEditor = document.getElementById("d") as HTMLElement
    setVisible(dialogEditor, true)
    setVisible(document.getElementById("m") as HTMLElement, true)

    press("a")
    expect(document.activeElement).toBe(dialogEditor)

    document.body.innerHTML = '<div role="dialog" data-state="open"><button id="b">Delete</button></div>'
    press("a")
    expect(document.activeElement).toBe(document.body)
  })

  it("picks the LAST VISIBLE editor in the zone, skipping hidden ones", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div contenteditable="true" id="visible"></div>' +
        '<div contenteditable="true" id="hidden"></div>' +
        "</main>"
    )
    setVisible(document.getElementById("visible") as HTMLElement, true)
    setVisible(document.getElementById("hidden") as HTMLElement, false)

    press("a")

    expect(document.activeElement).toBe(document.getElementById("visible"))
  })

  it("the last-clicked zone wins, falling back to main when it has no editor", () => {
    buildDom(
      '<main data-editor-zone="main"><div contenteditable="true" id="m"></div></main>' +
        '<aside data-editor-zone="panel"><div contenteditable="true" id="p"></div></aside>'
    )
    const main = document.getElementById("m") as HTMLElement
    const panel = document.getElementById("p") as HTMLElement
    setVisible(main, true)
    setVisible(panel, true)

    document.querySelector("aside")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    press("a")
    expect(document.activeElement).toBe(panel)

    // The whole panel goes away (the conversation closed), not just its editor —
    // a rendered panel without an editor deliberately keeps the keystroke.
    document.querySelector("aside")!.remove()
    main.blur()
    press("a")
    expect(document.activeElement).toBe(main)
  })

  it("a rendered panel with no composer (archived: the disabled notice) swallows the key instead of typing into a board card", () => {
    buildDom(
      '<main data-editor-zone="main"><div contenteditable="true" id="m"></div></main>' +
        '<aside data-editor-zone="panel"><p>Replies are closed on an archived conversation.</p></aside>'
    )
    const main = document.getElementById("m") as HTMLElement
    setVisible(main, true)

    document.querySelector("aside")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    press("a")

    expect(document.activeElement).not.toBe(main)
    expect(document.activeElement).toBe(document.body)
  })

  it("no panel at all: the key still falls back to main's editor", () => {
    buildDom(
      '<aside data-editor-zone="panel"><div contenteditable="true" id="p"></div></aside>' +
        '<main data-editor-zone="main"><div contenteditable="true" id="m"></div></main>'
    )
    const panel = document.getElementById("p") as HTMLElement
    const main = document.getElementById("m") as HTMLElement
    setVisible(panel, true)
    setVisible(main, true)

    document.querySelector("aside")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    document.querySelector("aside")!.remove()
    press("a")

    expect(document.activeElement).toBe(main)
  })

  it("a visible editor stays eligible when the visual viewport shrinks under the layout viewport (pinch-zoom / soft keyboard)", () => {
    buildDom('<main data-editor-zone="main"><div contenteditable="true" id="m"></div></main>')
    const main = document.getElementById("m") as HTMLElement
    setVisible(main, true)
    const original = window.visualViewport
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { width: 50, height: 50 },
    })

    press("a")

    expect(document.activeElement).toBe(main)
    Object.defineProperty(window, "visualViewport", { configurable: true, value: original })
  })

  it("skips an open card composer scrolled out of the viewport, taking the on-screen one instead", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div contenteditable="true" id="onscreen"></div>' +
        '<div contenteditable="true" id="below"></div>' +
        "</main>"
    )
    const onscreen = document.getElementById("onscreen") as HTMLElement
    const below = document.getElementById("below") as HTMLElement
    setVisible(onscreen, true)
    setScrolledOffScreen(below)

    press("a")

    expect(document.activeElement).toBe(onscreen)
    expect(document.activeElement).not.toBe(below)
  })

  it("main→panel: the panel's docked editor takes the key when the last click was in main and no card composer is open", () => {
    buildDom(
      '<main data-editor-zone="main"><div id="feed"></div></main>' +
        '<aside data-editor-zone="panel"><div contenteditable="true" id="p"></div></aside>'
    )
    const panel = document.getElementById("p") as HTMLElement
    setVisible(panel, true)

    document.getElementById("feed")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    press("a")

    expect(document.activeElement).toBe(panel)
  })
})
