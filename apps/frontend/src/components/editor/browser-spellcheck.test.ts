import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import { browserSpellcheckAttributes } from "./browser-spellcheck"

const ORIGINAL_USER_AGENT = navigator.userAgent

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true })
}

afterEach(() => {
  setUserAgent(ORIGINAL_USER_AGENT)
})

function mountEditor(): HTMLElement {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [Document, Paragraph, Text],
    editorProps: { attributes: browserSpellcheckAttributes() },
  })
  return editor.view.dom
}

describe("browserSpellcheckAttributes", () => {
  it("turns browser spellcheck off on the Android editor surface", () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36")
    expect(mountEditor().getAttribute("spellcheck")).toBe("false")
  })

  it("leaves the browser's spellcheck alone elsewhere", () => {
    setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
    )
    expect(mountEditor().hasAttribute("spellcheck")).toBe(false)
  })
})
