import { afterEach, describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import { createEditorExtensions } from "../editor-extensions"
import { DocCreatePluginKey, isDocCreatePending, takeOverNewDoc } from "./doc-create-extension"
import { DocSearchPluginKey } from "./doc-search-extension"
import type { DocSuggestionItem, NewDocItem } from "./use-doc-suggestion"

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
  const opened: { docId: string; text: string }[] = []
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
      takeOver: takeOverNewDoc(create, (docId) => opened.push({ docId, text: editor.getText() })),
    },
  })

  const el = document.createElement("div")
  document.body.appendChild(el)
  const editor = new Editor({ element: el, extensions, content: "" })
  editor.on("destroy", () => el.remove())
  editors.push(editor)
  return { editor, opened, pick: (item: Item) => pick!(item), settled: () => new Promise((r) => setTimeout(r, 0)) }
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

  it("should keep the typed /doc while the doc is created, then put its chip in place of it", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const titles: string[] = []
    const { editor, opened, pick, settled } = makeEditor((title) => {
      titles.push(title)
      return creation.promise
    })
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4 findings" })
    const whileCreating = editor.getText()
    creation.resolve({ id: "stream_new", displayName: "Q4 findings" })
    await settled()

    expect({ titles, whileCreating, opened, content: editor.getJSON().content?.[0]?.content }).toEqual({
      titles: ["Q4 findings"],
      whileCreating: "see /doc Q4 findings",
      opened: [{ docId: "stream_new", text: "see Q4 findings " }],
      content: [{ type: "text", text: "see " }, chip("stream_new", "Q4 findings"), { type: "text", text: " " }],
    })
  })

  it("should place the chip on the trigger when another tab rewrites the whole document while the doc is created", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const { editor, pick, settled } = makeEditor(() => creation.promise)
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4 findings" })
    const { doc, schema } = editor.state
    const remote = schema.nodes.paragraph.create(null, schema.text("intro"))
    const tr = editor.state.tr.replaceWith(0, doc.content.size, [remote, ...doc.content.content])
    editor.view.dispatch(tr)
    creation.resolve({ id: "stream_new", displayName: "Q4 findings" })
    await settled()

    expect(editor.getJSON().content?.map((block) => block.content)).toEqual([
      [{ type: "text", text: "intro" }],
      [{ type: "text", text: "see " }, chip("stream_new", "Q4 findings"), { type: "text", text: " " }],
    ])
  })

  it("should link nothing when the typed /doc was cleared while the doc was created", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const { editor, pick, settled } = makeEditor(() => creation.promise)
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4 findings" })
    editor.commands.clearContent()
    typeText(editor, "sent")
    creation.resolve({ id: "stream_new", displayName: "Q4 findings" })
    await settled()

    expect(editor.getJSON().content?.[0]?.content).toEqual([{ type: "text", text: "sent" }])
  })

  it("should keep text typed after the title while the doc was created", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const { editor, pick, settled } = makeEditor(() => creation.promise)
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4 findings" })
    typeText(editor, " now")
    creation.resolve({ id: "stream_new", displayName: "Q4 findings" })
    await settled()
    typeText(editor, "!")

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "see " },
      chip("stream_new", "Q4 findings"),
      { type: "text", text: " now!" },
    ])
  })

  it("should link nothing when the title was edited while the doc was created", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const { editor, pick, settled } = makeEditor(() => creation.promise)
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4 findings" })
    editor.view.dispatch(editor.state.tr.delete(editor.state.doc.content.size - 2, editor.state.doc.content.size - 1))
    creation.resolve({ id: "stream_new", displayName: "Q4 findings" })
    await settled()

    expect(editor.getText()).toBe("see /doc Q4 finding")
  })

  it("should link nothing when characters were appended to the title while the doc was created", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const { editor, pick, settled } = makeEditor(() => creation.promise)
    editor.commands.focus()
    typeText(editor, "see /doc Q4")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4" })
    typeText(editor, "x")
    creation.resolve({ id: "stream_new", displayName: "Q4" })
    await settled()

    expect(editor.getText()).toBe("see /doc Q4x")
  })

  it("should ignore a pick of an existing doc while the new doc is created", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const { editor, pick, settled } = makeEditor(() => creation.promise)
    editor.commands.focus()
    typeText(editor, "see /doc Q4")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4" })
    pick(PLAN)
    creation.resolve({ id: "stream_new", displayName: "Q4" })
    await settled()

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "see " },
      chip("stream_new", "Q4"),
      { type: "text", text: " " },
    ])
  })

  it("should report a pending create only until the doc is linked", async () => {
    const creation = deferred<{ id: string; displayName: string | null }>()
    const { editor, pick, settled } = makeEditor(() => creation.promise)
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    const before = isDocCreatePending(editor)
    pick({ kind: "new-doc", title: "Q4 findings" })
    const during = isDocCreatePending(editor)
    creation.resolve({ id: "stream_new", displayName: "Q4 findings" })
    await settled()

    expect({ before, during, after: isDocCreatePending(editor) }).toEqual({ before: false, during: true, after: false })
  })

  it("should leave the typed /doc untouched when the doc could not be created", async () => {
    const { editor, pick, settled } = makeEditor(async () => null)
    editor.commands.focus()
    typeText(editor, "see /doc Q4 findings")
    await new Promise((r) => setTimeout(r, 0))

    pick({ kind: "new-doc", title: "Q4 findings" })
    await settled()

    expect(editor.getText()).toBe("see /doc Q4 findings")
  })
})
