import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import Code from "@tiptap/extension-code"
import CodeBlock from "@tiptap/extension-code-block"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import { EmoticonExtension } from "./emoticon-extension"

const EMOTICONS: Record<string, string> = { ":)": "🙂", ":p": "😛", ":/": "😕", "<3": "❤️" }

let editor: Editor | null = null

function mount(
  content = "<p></p>",
  toEmoji: (emoticon: string) => string | null = (emoticon) => EMOTICONS[emoticon] ?? null
) {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [Document, Paragraph, Text, Code, CodeBlock, EmoticonExtension.configure({ toEmoji })],
    content,
  })
  editor.commands.focus("end")
  return editor
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

/** Types the way the browser does: each character is offered to the input rules before it lands. */
function type(text: string) {
  for (const char of text) {
    const { from, to } = editor!.state.selection
    const insert = () => editor!.state.tr.insertText(char, from, to)
    const handled = editor!.view.someProp("handleTextInput", (handler) => handler(editor!.view, from, to, char, insert))
    if (!handled) editor!.view.dispatch(insert())
  }
}

function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  editor!.view.dom.dispatchEvent(event)
  return event
}

const paragraphs = () => editor!.state.doc.children.map((node) => node.textContent)

describe("emoticon conversion", () => {
  it.each([
    ["hello :) ", "hello 🙂 "],
    [":p ", "😛 "],
    ["i <3 you", "i ❤️ you"],
    ["meh :/ ", "meh 😕 "],
  ])("converts %j once the word is finished", (typed, expected) => {
    mount()
    type(typed)
    expect(paragraphs()).toEqual([expected])
  })

  it.each([
    [":pray ", "a longer word that only starts like one"],
    ["https:/ ", "an emoticon at the end of another word"],
    ["a:) ", "an emoticon glued to a word"],
    [":)", "a word still being typed"],
  ])("leaves %j alone: %s", (typed) => {
    mount()
    type(typed)
    expect(paragraphs()).toEqual([typed])
  })

  it("converts a space that a composition already wrote into the document", async () => {
    mount()
    editor!.commands.insertContent("hello :) ")
    editor!.view.dom.dispatchEvent(new Event("compositionend"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(paragraphs()).toEqual(["hello 🙂 "])
  })

  it("converts before a new line", () => {
    mount()
    type("hello :)")
    press("Enter")
    expect(paragraphs()).toEqual(["hello 🙂", ""])
  })

  it("converts on demand for a send that never types a boundary", () => {
    mount()
    type("hello :)")
    expect(editor!.commands.commitEmoticon()).toBe(true)
    expect(paragraphs()).toEqual(["hello 🙂"])
    expect(editor!.commands.commitEmoticon()).toBe(false)
  })

  it("stays out of code", () => {
    mount("<pre><code></code></pre>")
    type(":) ")
    expect(editor!.getText()).toBe(":) ")

    editor!.destroy()
    mount("<p><code>x</code></p>")
    type(" :) ")
    expect(paragraphs()).toEqual(["x :) "])
  })

  it("converts nothing when the lookup knows no emoticons", () => {
    mount("<p></p>", () => null)
    type("hello :) ")
    expect(paragraphs()).toEqual(["hello :) "])
  })
})

describe("getting the text back", () => {
  it("undoes a conversion on Backspace", () => {
    mount()
    type("hello :) ")
    expect(editor!.commands.undoInputRule()).toBe(true)
    expect(paragraphs()).toEqual(["hello :) "])
    type("there ")
    expect(paragraphs()).toEqual(["hello :) there "])
  })

  it("keeps a word literal after Escape, however the word is finished", () => {
    mount()
    type("hello :)")
    expect(press("Escape").defaultPrevented).toBe(true)
    expect(editor!.can().commitEmoticon()).toBe(false)
    type(" ")
    expect(paragraphs()).toEqual(["hello :) "])
  })

  it("keeps a word literal when Escape came before it was complete", () => {
    mount()
    type("hello :")
    expect(press("Escape").defaultPrevented).toBe(false)
    type(") ")
    expect(paragraphs()).toEqual(["hello :) "])
  })

  it("spends the Escape that keeps an emoticon, and leaves every other one to the page", () => {
    const reached: string[] = []
    const listener = () => reached.push(paragraphs()[0])
    document.addEventListener("keydown", listener)
    mount()
    type("hi")
    press("Escape")
    type(" :)")
    press("Escape")
    press("Escape")
    document.removeEventListener("keydown", listener)
    expect(reached).toEqual(["hi", "hi :)"])
  })

  it("only protects the word Escape was pressed on", () => {
    mount()
    type(":)")
    press("Escape")
    type(" :) ")
    expect(paragraphs()).toEqual([":) 🙂 "])
  })

  it("forgets the Escape once the word is deleted", () => {
    mount()
    type(":)")
    press("Escape")
    editor!.commands.deleteRange({ from: 1, to: 3 })
    type(":) ")
    expect(paragraphs()).toEqual(["🙂 "])
  })
})
