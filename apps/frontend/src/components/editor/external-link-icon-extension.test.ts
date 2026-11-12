import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor, type JSONContent } from "@tiptap/core"
import { linkFaviconUrl } from "@/api"
import { createDocumentExtensions, createEditorExtensions } from "./editor-extensions"
import { serializeToMarkdown } from "./editor-markdown"
import * as Y from "yjs"

const editors: Editor[] = []
let faviconRequests: HTMLImageElement[] = []

beforeEach(() => {
  faviconRequests = []
  // jsdom never loads images, so the test settles each favicon request itself.
  vi.stubGlobal("Image", function () {
    const image = document.createElement("img")
    faviconRequests.push(image)
    return image
  })
})

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function link(text: string, href: string, extra: JSONContent["marks"] = []): JSONContent {
  return { type: "text", text, marks: [...extra, { type: "link", attrs: { href } }] }
}

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content }] }
}

function openEditor(content: JSONContent, workspaceId: string | null = "ws_1", withIcons = true) {
  const el = document.createElement("div")
  document.body.appendChild(el)
  const extensions = createEditorExtensions({ placeholder: "x", workspaceId }).filter(
    (extension) => withIcons || extension.name !== "externalLinkIconDecoration"
  )
  const editor = new Editor({ element: el, extensions, content })
  editor.on("destroy", () => el.remove())
  editors.push(editor)
  return editor
}

function icons(editor: Editor) {
  return Array.from(editor.view.dom.querySelectorAll<HTMLElement>(".editor-link-icon")).map((icon) => ({
    link: icon.closest("a")?.getAttribute("href") ?? null,
    icon: icon.className.match(/editor-link-icon-(\w+)/)?.[1] ?? null,
    favicon: icon.style.getPropertyValue("--editor-link-favicon") || null,
  }))
}

function requestedFavicons() {
  return faviconRequests.map((image) => image.getAttribute("src"))
}

const docsFavicon = linkFaviconUrl("ws_1", "docs.example.com")

describe("ExternalLinkIconDecoration", () => {
  it("should mark each external link's icon inside its anchor and none for mailto", () => {
    const editor = openEditor(
      paragraph(
        link("pr", "https://github.com/threahq/threa/pull/1"),
        { type: "text", text: " " },
        link("ticket", "https://linear.app/threa/issue/THR-51"),
        { type: "text", text: " " },
        link("docs", "https://docs.example.com/a"),
        { type: "text", text: " " },
        link("mail", "mailto:someone@example.com")
      )
    )

    expect({ icons: icons(editor), requested: requestedFavicons() }).toEqual({
      icons: [
        { link: "https://github.com/threahq/threa/pull/1", icon: "github", favicon: null },
        { link: "https://linear.app/threa/issue/THR-51", icon: "linear", favicon: null },
        { link: "https://docs.example.com/a", icon: "globe", favicon: null },
      ],
      requested: [docsFavicon],
    })
  })

  it("should draw one icon for a partly bold link and one per adjacent link", () => {
    const editor = openEditor(
      paragraph(
        link("bold", "https://a.example.com/", [{ type: "bold" }]),
        link(" rest", "https://a.example.com/"),
        link("next", "https://b.example.com/")
      ),
      null
    )

    expect(icons(editor).map((icon) => icon.link)).toEqual(["https://a.example.com/", "https://b.example.com/"])
  })

  it("should leave the document, text and markdown as they are without icons", () => {
    const content = paragraph(
      { type: "text", text: "see " },
      link("pr", "https://github.com/threahq/threa/pull/1"),
      { type: "text", text: " and " },
      link("docs", "https://docs.example.com/a")
    )
    const read = (editor: Editor) => ({
      json: editor.getJSON(),
      text: editor.getText(),
      domText: editor.view.dom.textContent,
      markdown: serializeToMarkdown(editor.getJSON()),
    })

    const decorated = openEditor(content)
    const plain = openEditor(content, "ws_1", false)

    expect({ icons: icons(decorated).length, ...read(decorated) }).toEqual({ icons: 2, ...read(plain) })
  })

  it("should draw the favicon once it has loaded", () => {
    const editor = openEditor(paragraph(link("docs", "https://docs.example.com/a")))

    faviconRequests[0].dispatchEvent(new Event("load"))

    expect(icons(editor)).toEqual([
      { link: "https://docs.example.com/a", icon: "favicon", favicon: `url("${docsFavicon}")` },
    ])
  })

  it("should keep the globe after a failed favicon and ask again only after thirty seconds", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const editor = openEditor(paragraph(link("docs", "https://docs.example.com/a")))
    const addLink = (text: string) =>
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, [
        { type: "text", text: " " },
        link(text, `https://docs.example.com/${text}`),
      ])

    faviconRequests[0].dispatchEvent(new Event("error"))
    vi.advanceTimersByTime(29_000)
    addLink("b")
    const requestedWithinWindow = requestedFavicons()
    vi.advanceTimersByTime(1_000)
    addLink("c")

    expect({
      icons: icons(editor).map((icon) => icon.icon),
      requestedWithinWindow,
      requested: requestedFavicons(),
    }).toEqual({
      icons: ["globe", "globe", "globe"],
      requestedWithinWindow: [docsFavicon],
      requested: [docsFavicon, docsFavicon],
    })
  })

  it("should ask once more for a failed favicon after thirty seconds without an edit", () => {
    vi.useFakeTimers()
    const editor = openEditor(paragraph(link("docs", "https://docs.example.com/a")))

    faviconRequests[0].dispatchEvent(new Event("error"))
    vi.advanceTimersByTime(30_000)
    const requestedAfterFirstMiss = requestedFavicons()
    faviconRequests[1].dispatchEvent(new Event("error"))
    vi.advanceTimersByTime(120_000)

    expect({
      icons: icons(editor).map((icon) => icon.icon),
      requestedAfterFirstMiss,
      requested: requestedFavicons(),
    }).toEqual({
      icons: ["globe"],
      requestedAfterFirstMiss: [docsFavicon, docsFavicon],
      requested: [docsFavicon, docsFavicon],
    })
  })

  it("should request no favicon without a workspace", () => {
    const editor = openEditor(paragraph(link("docs", "https://docs.example.com/a")), null)

    expect({ icons: icons(editor), requested: requestedFavicons() }).toEqual({
      icons: [{ link: "https://docs.example.com/a", icon: "globe", favicon: null }],
      requested: [],
    })
  })

  it("should draw icons in the collaborative document editor", () => {
    const el = document.createElement("div")
    document.body.appendChild(el)
    const editor = new Editor({
      element: el,
      extensions: createDocumentExtensions({ ydoc: new Y.Doc(), awareness: null, workspaceId: "ws_1" }),
    })
    editor.on("destroy", () => el.remove())
    editors.push(editor)

    editor.commands.setContent(paragraph(link("pr", "https://github.com/threahq/threa/pull/1")))

    expect(icons(editor)).toEqual([{ link: "https://github.com/threahq/threa/pull/1", icon: "github", favicon: null }])
  })
})
