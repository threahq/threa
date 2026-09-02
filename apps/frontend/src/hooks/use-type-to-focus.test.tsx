import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render } from "@testing-library/react"
import { findVisibleZoneEditor, useTypeToFocus } from "./use-type-to-focus"

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

  it("two panel zones (a thread in the aside stage's host pane beside the aside's column): the last-clicked one takes the key", () => {
    buildDom(
      '<div data-editor-zone="panel" id="thread"><div contenteditable="true" id="t"></div></div>' +
        '<div data-editor-zone="panel" id="aside"><div contenteditable="true" id="a"></div></div>'
    )
    const thread = document.getElementById("t") as HTMLElement
    const asideEditor = document.getElementById("a") as HTMLElement
    setVisible(thread, true)
    setVisible(asideEditor, true)

    document.getElementById("aside")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    press("a")
    expect(document.activeElement).toBe(asideEditor)

    // The clicked zone goes away (the aside closed); document order rules again.
    asideEditor.blur()
    document.getElementById("aside")!.remove()
    press("a")
    expect(document.activeElement).toBe(thread)
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
      '<main data-editor-zone="main"><div data-type-capture-scope id="feed"></div></main>' +
        '<aside data-editor-zone="panel"><div contenteditable="true" id="p"></div></aside>'
    )
    const panel = document.getElementById("p") as HTMLElement
    setVisible(panel, true)

    document.getElementById("feed")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    press("a")

    expect(document.activeElement).toBe(panel)
  })
})

describe("useTypeToFocus card scopes", () => {
  /** Runs the hook's bounded rAF poll to completion. */
  function runFrames(count = 25) {
    for (let i = 0; i < count; i += 1) vi.advanceTimersByTime(16)
  }

  function clickIn(id: string) {
    document.getElementById(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  }

  let execCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    execCommand = vi.fn(() => true)
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("routes the key to the last-clicked card's editor, not the last card in the feed", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA"><div id="rowA"></div><div contenteditable="true" id="a"></div></div>' +
        '<div data-type-capture-scope id="cardB"><div contenteditable="true" id="b"></div></div>' +
        "</main>"
    )
    const a = document.getElementById("a") as HTMLElement
    const b = document.getElementById("b") as HTMLElement
    setVisible(a, true)
    setVisible(b, true)

    clickIn("rowA")
    press("x")

    expect(document.activeElement).toBe(a)
    expect(document.activeElement).not.toBe(b)
  })

  it("within one card, the card-level reply editor (last in DOM) beats an earlier open branch editor", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA">' +
        '<div id="rowA"></div>' +
        '<div contenteditable="true" id="branch"></div>' +
        '<div contenteditable="true" id="reply"></div>' +
        "</div>" +
        "</main>"
    )
    const branch = document.getElementById("branch") as HTMLElement
    const reply = document.getElementById("reply") as HTMLElement
    setVisible(branch, true)
    setVisible(reply, true)

    clickIn("rowA")
    press("x")

    expect(document.activeElement).toBe(reply)
    expect(document.activeElement).not.toBe(branch)
  })

  it("opens the clicked card's resting composer and types the swallowed character into it", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA"><div id="rowA"></div><button data-composer-opener id="opener"></button></div>' +
        '<div data-type-capture-scope id="cardB"><div contenteditable="true" id="b"></div></div>' +
        "</main>"
    )
    setVisible(document.getElementById("b") as HTMLElement, true)
    const cardA = document.getElementById("cardA") as HTMLElement
    const opener = document.getElementById("opener") as HTMLButtonElement
    setVisible(opener, true)
    // The real composer mounts on the opener's click, a frame or more later.
    opener.addEventListener("click", () => {
      opener.remove()
      const editor = document.createElement("div")
      editor.setAttribute("contenteditable", "true")
      editor.id = "a"
      cardA.appendChild(editor)
      setVisible(editor, true)
    })

    clickIn("rowA")
    const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    runFrames()

    expect(document.activeElement).toBe(document.getElementById("a"))
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "x")
    expect(document.activeElement).not.toBe(document.getElementById("b"))
  })

  it("gives up silently when the opener never mounts an editor", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA"><div id="rowA"></div><button data-composer-opener id="opener"></button></div>' +
        "</main>"
    )
    setVisible(document.getElementById("opener") as HTMLElement, true)

    clickIn("rowA")
    expect(() => {
      press("x")
      runFrames()
    }).not.toThrow()

    expect(document.activeElement).toBe(document.body)
    expect(execCommand).not.toHaveBeenCalled()
  })

  it("an archived card (no editor, no opener) swallows the key instead of typing into another card", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA"><div id="rowA"></div><p>Replies are closed.</p></div>' +
        '<div data-type-capture-scope id="cardB"><div contenteditable="true" id="b"></div></div>' +
        "</main>"
    )
    const b = document.getElementById("b") as HTMLElement
    setVisible(b, true)

    clickIn("rowA")
    press("x")

    expect(document.activeElement).not.toBe(b)
    expect(document.activeElement).toBe(document.body)
  })

  it("opens the card's OWN reply bar, not a branch bar that comes earlier in the card", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA">' +
        '<div id="rowA"></div>' +
        '<button id="branch"></button>' +
        '<button data-composer-opener id="opener"></button>' +
        "</div>" +
        "</main>"
    )
    const branch = document.getElementById("branch") as HTMLButtonElement
    const opener = document.getElementById("opener") as HTMLButtonElement
    setVisible(branch, true)
    setVisible(opener, true)
    const branchClick = vi.fn()
    branch.addEventListener("click", branchClick)
    const openerClick = vi.fn()
    opener.addEventListener("click", openerClick)

    clickIn("rowA")
    press("x")

    expect(openerClick).toHaveBeenCalled()
    expect(branchClick).not.toHaveBeenCalled()
  })

  it("an open panel with a live editor outranks the card scope the conversation was opened from", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA"><div id="rowA"></div><button data-composer-opener id="opener"></button></div>' +
        "</main>" +
        '<aside data-editor-zone="panel"><div contenteditable="true" id="p"></div></aside>'
    )
    const opener = document.getElementById("opener") as HTMLButtonElement
    const panel = document.getElementById("p") as HTMLElement
    setVisible(opener, true)
    setVisible(panel, true)
    const openerClick = vi.fn()
    opener.addEventListener("click", openerClick)

    clickIn("rowA")
    press("x")

    expect(document.activeElement).toBe(panel)
    expect(openerClick).not.toHaveBeenCalled()
  })

  it("swallows the key when the card's opener is scrolled off-screen, rather than yanking the feed to it", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA"><div id="rowA"></div><button data-composer-opener id="opener"></button></div>' +
        '<div data-type-capture-scope id="cardB"><div contenteditable="true" id="b"></div></div>' +
        "</main>"
    )
    const opener = document.getElementById("opener") as HTMLButtonElement
    setScrolledOffScreen(opener)
    setVisible(document.getElementById("b") as HTMLElement, true)
    const openerClick = vi.fn()
    opener.addEventListener("click", openerClick)

    clickIn("rowA")
    press("x")
    runFrames()

    expect(openerClick).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(document.body)
    expect(execCommand).not.toHaveBeenCalled()
  })

  it("accumulates keys pressed while the composer is still mounting and inserts them together", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA"><div id="rowA"></div><button data-composer-opener id="opener"></button></div>' +
        "</main>"
    )
    const cardA = document.getElementById("cardA") as HTMLElement
    const opener = document.getElementById("opener") as HTMLButtonElement
    setVisible(opener, true)
    // Mounts only after a couple of frames, leaving a real typing window.
    let framesUntilMount = 3
    opener.addEventListener("click", () => {
      const mount = () => {
        framesUntilMount -= 1
        if (framesUntilMount > 0) {
          requestAnimationFrame(mount)
          return
        }
        opener.remove()
        const editor = document.createElement("div")
        editor.setAttribute("contenteditable", "true")
        editor.id = "a"
        cardA.appendChild(editor)
        setVisible(editor, true)
      }
      requestAnimationFrame(mount)
    })

    clickIn("rowA")
    press("x")
    const second = new KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true })
    document.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(true)
    runFrames()

    expect(document.activeElement).toBe(document.getElementById("a"))
    expect(execCommand).toHaveBeenCalledTimes(1)
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "xy")
  })

  it("on a coarse pointer it only clicks the opener — the floating composer autofocuses itself", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div data-type-capture-scope id="cardA"><div id="rowA"></div><button data-composer-opener id="opener"></button></div>' +
        "</main>"
    )
    const opener = document.getElementById("opener") as HTMLButtonElement
    setVisible(opener, true)
    const openerClick = vi.fn()
    opener.addEventListener("click", openerClick)
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({ ...originalMatchMedia(query), matches: query === "(pointer: coarse)" }),
    })

    const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true })
    clickIn("rowA")
    document.dispatchEvent(event)
    runFrames()
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: originalMatchMedia })

    expect(openerClick).toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(execCommand).not.toHaveBeenCalled()
  })

  it("a click outside any card scope keeps the zone-wide behavior", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div id="header"></div>' +
        '<div data-type-capture-scope id="cardB"><div contenteditable="true" id="b"></div></div>' +
        "</main>"
    )
    const b = document.getElementById("b") as HTMLElement
    setVisible(b, true)

    clickIn("header")
    press("x")

    expect(document.activeElement).toBe(b)
  })
})

describe("findVisibleZoneEditor", () => {
  it("skips a later visible inline-edit editor in favor of the standard composer", () => {
    buildDom(
      '<main data-editor-zone="main">' +
        '<div contenteditable="true" id="composer"></div>' +
        '<div data-inline-edit><div contenteditable="true" id="edit"></div></div>' +
        "</main>"
    )
    const composer = document.getElementById("composer") as HTMLElement
    const edit = document.getElementById("edit") as HTMLElement
    setVisible(composer, true)
    setVisible(edit, true)

    expect(findVisibleZoneEditor(document.querySelector<HTMLElement>('[data-editor-zone="main"]'))).toBe(composer)
  })

  it("returns null for an absent zone container", () => {
    buildDom('<main data-editor-zone="main"><div contenteditable="true" id="c"></div></main>')
    setVisible(document.getElementById("c")!, true)

    expect(findVisibleZoneEditor(document.querySelector<HTMLElement>('[data-editor-zone="panel"]'))).toBeNull()
  })
})
