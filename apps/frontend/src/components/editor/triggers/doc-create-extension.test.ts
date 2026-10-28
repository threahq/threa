import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { DocCreatePluginKey } from "./doc-create-extension"
import { DocSearchPluginKey } from "./doc-search-extension"
import { isNewDoc, type DocSuggestionItem, type NewDocItem } from "./use-doc-suggestion"
import { linkCreatedDoc } from "./use-doc-create-suggestion"

type Item = DocSuggestionItem | NewDocItem

const editors: Editor[] = []

const PLAN: DocSuggestionItem = {
  id: "stream_plan",
  displayName: "Q4 findings",
  parentStreamId: "stream_host",
  createdAt: "2026-10-01T00:00:00.000Z",
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function makeEditor(create: (title: string) => Promise<{ id: string; displayName: string | null } | null>) {
  let pick: ((item: Item) => void) | null = null
  const links: Promise<void>[] = []
  const capture = (props: { command: (item: Item) => void }) => {
    pick = props.command
  }
  const extensions = createEditorExtensions({
    placeholder: "x",
    docSearchSuggestion: {
      items: () => [],
      render: () => ({ onStart() {}, onUpdate() {}, onExit() {}, onKeyDown: () => false }),
    },
    docCreate: {
      suggestion: {
        items: () => [],
        render: () => ({ onStart: capture, onUpdate: capture, onExit() {}, onKeyDown: () => false }),
      },
      onPick: ({ editor, item, at }) => {
        if (isNewDoc(item)) links.push(linkCreatedDoc(editor, at, () => create(item.title), `/doc ${item.title}`))
      },
    },
  })

  const el = document.createElement("div")
  document.body.appendChild(el)
  const editor = new Editor({ element: el, extensions, content: "" })
  editor.on("destroy", () => el.remove())
  editors.push(editor)
  return { editor, pick: (item: Item) => pick!(item), settled: () => Promise.all(links) }
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
})

function typeText(editor: Editor, text: string) {
  for (const ch of text) editor.view.dispatch(editor.state.tr.insertText(ch))
}

function state(editor: Editor, key: typeof DocCreatePluginKey) {
  const { active, query } = key.getState(editor.state) as { active: boolean; query: string | null }
  return { active, query }
}

const chip = (docId: string, title: string) => ({ type: "docEmbed", attrs: { docId, blockId: null, title } })

describe("DocCreateExtension", () => {
  it("should capture the title after /doc and leave /docs to the link picker", () => {
    const { editor } = makeEditor(async () => null)
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    const created = state(editor, DocCreatePluginKey)

    editor.commands.clearContent()
    typeText(editor, "see /docs Q4")
    expect({
      created,
      createWhileLinking: state(editor, DocCreatePluginKey).active,
      linking: state(editor, DocSearchPluginKey),
    }).toEqual({
      created: { active: true, query: "Q4 findings" },
      createWhileLinking: false,
      linking: { active: true, query: "Q4" },
    })
  })

  it("should link an existing doc in place when one of the matches is picked", async () => {
    const { editor, pick } = makeEditor(async () => null)
    editor.commands.focus()
    typeText(editor, "see /doc Q4")
    await new Promise((r) => setTimeout(r, 0))

    pick(PLAN)

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "see " },
      chip("stream_plan", "Q4 findings"),
      { type: "text", text: " " },
    ])
  })

  it("should put the new doc's chip where /doc was typed when text is typed while it is created", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const titles: string[] = []
    const { editor, pick, settled } = makeEditor((title) => {
      titles.push(title)
      return creation.promise
    })
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4 findings" })
    typeText(editor, "now")
    creation.resolve({ id: "stream_new", displayName: "Q4 findings" })
    await settled()

    expect({ titles, content: editor.getJSON().content?.[0]?.content }).toEqual({
      titles: ["Q4 findings"],
      content: [{ type: "text", text: "see " }, chip("stream_new", "Q4 findings"), { type: "text", text: " now" }],
    })
  })

  it("should give the typed /doc back when the doc could not be created", async () => {
    const { editor, pick, settled } = makeEditor(async () => null)
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4 findings" })
    await settled()

    expect(editor.getText()).toBe("see /doc Q4 findings")
  })
})
