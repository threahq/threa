import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import { AndroidSpellcheckKeyboard } from "./android-spellcheck-keyboard"

const ORIGINAL_USER_AGENT = navigator.userAgent
const ORIGINAL_VISUAL_VIEWPORT = Object.getOwnPropertyDescriptor(window, "visualViewport")
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36"
const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
const VIEWPORT_WITHOUT_KEYBOARD = 800
const VIEWPORT_WITH_KEYBOARD = 450

type FakeViewport = EventTarget & { height: number }
let viewport: FakeViewport
let editor: Editor

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true })
}

function resizeViewport(height: number) {
  viewport.height = height
  viewport.dispatchEvent(new Event("resize"))
}

function mount({ userAgent = ANDROID_UA, viewportHeight = VIEWPORT_WITHOUT_KEYBOARD } = {}) {
  setUserAgent(userAgent)
  viewport.height = viewportHeight
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [Document, Paragraph, Text, AndroidSpellcheckKeyboard],
    content: "<p>Kaffemått</p>",
  })
  editor.view.focus()
  const blur = vi.spyOn(editor.view.dom, "blur")
  const focus = vi.spyOn(editor.view, "focus")
  return { blur, focus }
}

function tap(target: EventTarget) {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  target.dispatchEvent(new Event("pointerup", { bubbles: true }))
}

/** Chrome hands a touch that pans over to scrolling and ends it with pointercancel, never pointerup. */
function scroll(target: EventTarget) {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }))
  target.dispatchEvent(new Event("pointercancel", { bubbles: true }))
}

function spellcheck() {
  return editor.view.dom.getAttribute("spellcheck")
}

/** The keyboard is up, the user taps a squiggled word, and Chrome's menu drops the keyboard while the editor keeps focus. */
function menuOpensOnTappedWord() {
  resizeViewport(VIEWPORT_WITH_KEYBOARD)
  tap(editor.view.dom)
  resizeViewport(VIEWPORT_WITHOUT_KEYBOARD)
}

/** The menu was swiped away (no input reaches the page), then the user taps the same word again. */
function tapAfterDismissedMenu() {
  menuOpensOnTappedWord()
  tap(editor.view.dom)
}

/** Dispatches the input and runs the timers the extension defers its work to, as a user would see it settle. */
function input(inputType: string, data: string | null = null) {
  editor.view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true }))
  vi.runAllTimers()
}

/** Chrome's menu fires this for a picked suggestion and for its Delete (a replacement with ""). */
function applySuggestion() {
  input("insertReplacementText")
}

beforeEach(() => {
  vi.useFakeTimers()
  viewport = Object.assign(new EventTarget(), { height: VIEWPORT_WITHOUT_KEYBOARD })
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport })
})

afterEach(() => {
  editor?.destroy()
  vi.useRealTimers()
  setUserAgent(ORIGINAL_USER_AGENT)
  if (ORIGINAL_VISUAL_VIEWPORT) Object.defineProperty(window, "visualViewport", ORIGINAL_VISUAL_VIEWPORT)
  else delete (window as { visualViewport?: unknown }).visualViewport
})

describe("AndroidSpellcheckKeyboard keyboard restore", () => {
  it("refocuses the editor after a suggestion is applied with the keyboard dropped", () => {
    const { blur, focus } = mount()
    menuOpensOnTappedWord()

    applySuggestion()

    expect(blur).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it("restores for an editor that mounted under an open keyboard", () => {
    const { blur, focus } = mount({ viewportHeight: VIEWPORT_WITH_KEYBOARD })
    tap(editor.view.dom)
    resizeViewport(VIEWPORT_WITHOUT_KEYBOARD)

    applySuggestion()

    expect(blur).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it("stays armed through input the menu does not produce", () => {
    const { blur } = mount()
    menuOpensOnTappedWord()

    input("insertFromPaste")
    expect(blur).not.toHaveBeenCalled()

    applySuggestion()
    expect(blur).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["typing with the keyboard up", () => resizeViewport(VIEWPORT_WITH_KEYBOARD)],
    [
      "URL-bar movement",
      () => {
        tap(editor.view.dom)
        resizeViewport(760)
        resizeViewport(VIEWPORT_WITHOUT_KEYBOARD)
      },
    ],
    [
      "a keyboard hidden without a tap on the editor",
      () => {
        resizeViewport(VIEWPORT_WITH_KEYBOARD)
        resizeViewport(VIEWPORT_WITHOUT_KEYBOARD)
      },
    ],
    [
      "a keyboard hidden after a scroll on the editor",
      () => {
        resizeViewport(VIEWPORT_WITH_KEYBOARD)
        scroll(editor.view.dom)
        resizeViewport(VIEWPORT_WITHOUT_KEYBOARD)
      },
    ],
    [
      "a keyboard hidden after a touch elsewhere followed the tap",
      () => {
        resizeViewport(VIEWPORT_WITH_KEYBOARD)
        tap(editor.view.dom)
        tap(document.body)
        resizeViewport(VIEWPORT_WITHOUT_KEYBOARD)
      },
    ],
    [
      "a keyboard hidden long after the last tap",
      () => {
        resizeViewport(VIEWPORT_WITH_KEYBOARD)
        tap(editor.view.dom)
        vi.advanceTimersByTime(3_001)
        resizeViewport(VIEWPORT_WITHOUT_KEYBOARD)
      },
    ],
    [
      "a touch after the drop",
      () => {
        menuOpensOnTappedWord()
        tap(document.body)
      },
    ],
    [
      "a key press after the drop",
      () => {
        menuOpensOnTappedWord()
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
      },
    ],
    [
      "a drop older than the menu could be",
      () => {
        menuOpensOnTappedWord()
        vi.advanceTimersByTime(15_001)
      },
    ],
  ])("leaves the editor alone after %s", (_, arrange) => {
    const { blur } = mount()
    arrange()

    applySuggestion()

    expect(blur).not.toHaveBeenCalled()
  })
})

describe("AndroidSpellcheckKeyboard spellcheck pause", () => {
  it("pauses spellcheck when the editor is tapped after a dismissed menu", () => {
    mount()

    tapAfterDismissedMenu()

    expect(spellcheck()).toBe("false")
  })

  it.each([
    ["no menu before it", () => {}],
    [
      "a keyboard hidden without a tap on the editor",
      () => {
        resizeViewport(VIEWPORT_WITH_KEYBOARD)
        resizeViewport(VIEWPORT_WITHOUT_KEYBOARD)
      },
    ],
    [
      "a tap elsewhere first",
      () => {
        menuOpensOnTappedWord()
        tap(document.body)
      },
    ],
    [
      "a suggestion already applied",
      () => {
        menuOpensOnTappedWord()
        applySuggestion()
      },
    ],
  ])("keeps spellcheck for a tap after %s", (_, arrange) => {
    mount()
    arrange()

    tap(editor.view.dom)

    expect(spellcheck()).toBeNull()
  })

  it("pauses on the tap, not on a scroll over the text", () => {
    mount()
    menuOpensOnTappedWord()

    scroll(editor.view.dom)
    expect(spellcheck()).toBeNull()

    tap(editor.view.dom)
    expect(spellcheck()).toBe("false")
  })

  it.each([
    ["a space", "insertText", " "],
    ["a line break", "insertParagraph", null],
  ])("resumes spellcheck once the user types %s", (_, inputType, data) => {
    mount()
    tapAfterDismissedMenu()

    input("insertText", "s")
    expect(spellcheck()).toBe("false")

    input(inputType, data)
    expect(spellcheck()).toBeNull()
  })

  it("resumes spellcheck when the editor loses focus", () => {
    mount()
    tapAfterDismissedMenu()

    editor.view.dom.blur()

    expect(spellcheck()).toBeNull()
  })
})

it("does nothing off Android", () => {
  const { blur } = mount({ userAgent: IOS_UA })
  menuOpensOnTappedWord()

  applySuggestion()
  tap(editor.view.dom)

  expect(blur).not.toHaveBeenCalled()
  expect(spellcheck()).toBeNull()
})
