import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { prosemirrorJSONToYDoc } from "y-prosemirror"
import { DOC_FRAGMENT } from "@threahq/types"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { createDocumentExtensions } from "./editor-extensions"
import { BLOCK_HIGHLIGHT_MS } from "./doc-block-landing-extension"

const editors: Editor[] = []
const originalScrollIntoView = Element.prototype.scrollIntoView
let scrolled: Element[]

const BLOCKS: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", attrs: { blockId: "blk_intro" }, content: [{ type: "text", text: "Intro" }] },
    { type: "paragraph", attrs: { blockId: "blk_rota" }, content: [{ type: "text", text: "Rota" }] },
  ],
}

function createEditor(): Editor {
  const element = document.createElement("div")
  document.body.append(element)
  const ydoc = prosemirrorJSONToYDoc(getThreaSchema(), BLOCKS, DOC_FRAGMENT)
  const editor = new Editor({ element, extensions: createDocumentExtensions({ ydoc, awareness: null }) })
  editor.on("destroy", () => element.remove())
  editors.push(editor)
  return editor
}

const highlighted = (editor: Editor) =>
  [...editor.view.dom.children].filter((el) => el.classList.contains("bg-primary/10")).map((el) => el.textContent)

beforeEach(() => {
  scrolled = []
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
})

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  Element.prototype.scrollIntoView = originalScrollIntoView
  vi.useRealTimers()
})

describe("DocBlockLanding", () => {
  it("should scroll to and highlight the block, then clear the highlight when the highlight time passes", () => {
    vi.useFakeTimers()
    const editor = createEditor()

    const landed = editor.commands.landOnBlock("blk_rota")
    const during = { scrolled: scrolled.map((el) => el.textContent), highlighted: highlighted(editor) }
    vi.advanceTimersByTime(BLOCK_HIGHLIGHT_MS)

    expect({ landed, ...during, after: highlighted(editor) }).toEqual({
      landed: true,
      scrolled: ["Rota"],
      highlighted: ["Rota"],
      after: [],
    })
  })

  it("should keep the highlight on the block when the whole doc is replaced under it", () => {
    const editor = createEditor()
    editor.commands.landOnBlock("blk_rota")

    editor.commands.setContent(BLOCKS)

    expect(highlighted(editor)).toEqual(["Rota"])
  })

  it("should return false and leave the doc alone when no block has the id", () => {
    const editor = createEditor()

    expect({ landed: editor.commands.landOnBlock("blk_missing"), scrolled, highlighted: highlighted(editor) }).toEqual({
      landed: false,
      scrolled: [],
      highlighted: [],
    })
  })
})
