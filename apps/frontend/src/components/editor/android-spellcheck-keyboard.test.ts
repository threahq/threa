import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import { AndroidSpellcheckKeyboard } from "./android-spellcheck-keyboard"

const ORIGINAL_USER_AGENT = navigator.userAgent
const ORIGINAL_VISUAL_VIEWPORT = Object.getOwnPropertyDescriptor(window, "visualViewport")
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36"

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

function mount(userAgent = ANDROID_UA, viewportHeight = 800) {
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

/** The keyboard was up (viewport shrunk), then Chrome's popup dropped it while the editor kept focus. */
function keyboardDropsUnderPopup() {
  resizeViewport(800)
  resizeViewport(450)
  resizeViewport(800)
}

function input(inputType: string) {
  editor.view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true }))
  vi.runAllTimers()
}

/** Chrome's menu fires this for a picked suggestion and for its Delete (a replacement with ""). */
const applySuggestion = () => input("insertReplacementText")

beforeEach(() => {
  vi.useFakeTimers()
  viewport = Object.assign(new EventTarget(), { height: 800 })
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport })
})

afterEach(() => {
  editor?.destroy()
  vi.useRealTimers()
  setUserAgent(ORIGINAL_USER_AGENT)
  if (ORIGINAL_VISUAL_VIEWPORT) Object.defineProperty(window, "visualViewport", ORIGINAL_VISUAL_VIEWPORT)
  else delete (window as { visualViewport?: unknown }).visualViewport
})

describe("AndroidSpellcheckKeyboard", () => {
  it("refocuses the editor after a suggestion is applied with the keyboard dropped", () => {
    const { blur, focus } = mount()
    keyboardDropsUnderPopup()
    applySuggestion()
    expect(blur).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it("restores for an editor that mounted under an open keyboard", () => {
    const { blur, focus } = mount(ANDROID_UA, 450)
    resizeViewport(800)
    applySuggestion()
    expect(blur).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it("stays armed through input the menu does not produce", () => {
    const { blur } = mount()
    keyboardDropsUnderPopup()
    input("insertFromPaste")
    expect(blur).not.toHaveBeenCalled()
    applySuggestion()
    expect(blur).toHaveBeenCalledTimes(1)
  })

  it("leaves typing alone while the keyboard is up", () => {
    const { blur } = mount()
    resizeViewport(450)
    applySuggestion()
    expect(blur).not.toHaveBeenCalled()
  })

  it("ignores URL-bar movement", () => {
    const { blur } = mount()
    resizeViewport(760)
    resizeViewport(800)
    applySuggestion()
    expect(blur).not.toHaveBeenCalled()
  })

  it("stands down once the user touches the page or presses a key", () => {
    const { blur } = mount()
    keyboardDropsUnderPopup()
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    applySuggestion()
    keyboardDropsUnderPopup()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
    applySuggestion()
    expect(blur).not.toHaveBeenCalled()
  })

  it("forgets a drop older than the menu could be", () => {
    const { blur } = mount()
    keyboardDropsUnderPopup()
    vi.advanceTimersByTime(15_001)
    applySuggestion()
    expect(blur).not.toHaveBeenCalled()
  })

  it("does nothing off Android", () => {
    const { blur } = mount("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")
    keyboardDropsUnderPopup()
    applySuggestion()
    expect(blur).not.toHaveBeenCalled()
  })
})
