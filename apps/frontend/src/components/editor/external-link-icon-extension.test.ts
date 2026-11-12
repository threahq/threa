import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor, type Extensions, type JSONContent } from "@tiptap/core"
import { linkFaviconUrl } from "@/api"
import { createDocumentExtensions, createEditorExtensions } from "./editor-extensions"
import { serializeToMarkdown } from "./editor-markdown"
import { ExternalLinkIconDecoration } from "./external-link-icon-extension"
import * as Y from "yjs"

const editors: Editor[] = []
let faviconRequests: HTMLImageElement[] = []

beforeEach(() => {
  vi.useFakeTimers()
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

function mountEditor(extensions: Extensions, content?: JSONContent) {
  const el = document.createElement("div")
  document.body.appendChild(el)
  const editor = new Editor({ element: el, extensions, content })
  editor.on("destroy", () => el.remove())
  editors.push(editor)
  return editor
}

function openEditor(content: JSONContent, options: { workspaceId?: string | null; icons?: boolean } = {}) {
  const { workspaceId = "ws_1", icons = true } = options
  const extensions = createEditorExtensions({ placeholder: "x", workspaceId }).filter(
    (extension) => icons || extension.name !== ExternalLinkIconDecoration.name
  )
  return mountEditor(extensions, content)
}

function icons(editor: Editor) {
  return Array.from(editor.view.dom.querySelectorAll<HTMLElement>(".editor-link-icon")).map((icon) => ({
    link: icon.closest("a")?.getAttribute("href") ?? null,
    icon: icon.className.match(/external-link-icon-(\w+)/)?.[1] ?? null,
    favicon: icon.style.getPropertyValue("--external-link-glyph") || null,
  }))
}

function requestedFavicons() {
  return faviconRequests.map((image) => image.getAttribute("src"))
}

function settle(request: number, outcome: "load" | "error") {
  faviconRequests[request].dispatchEvent(new Event(outcome))
}

const docsLink = link("docs", "https://docs.example.com/a")
const docsFavicon = linkFaviconUrl("ws_1", "docs.example.com")

describe("ExternalLinkIconDecoration", () => {
  it("should mark each external link's icon inside its anchor and none for mailto or the app's own links", () => {
    const editor = openEditor(
      paragraph(
        link("pr", "https://github.com/threahq/threa/pull/1"),
        { type: "text", text: " " },
        link("ticket", "https://linear.app/threa/issue/THR-51"),
        { type: "text", text: " " },
        docsLink,
        { type: "text", text: " " },
        link("mail", "mailto:someone@example.com"),
        { type: "text", text: " " },
        link("stream", `${window.location.origin}/w/ws_1/s/stream_1`)
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
      { workspaceId: null }
    )

    expect(icons(editor).map((icon) => icon.link)).toEqual(["https://a.example.com/", "https://b.example.com/"])
  })

  it("should leave the document, text and markdown as they are without icons", () => {
    const content = paragraph(
      { type: "text", text: "see " },
      link("pr", "https://github.com/threahq/threa/pull/1"),
      { type: "text", text: " and " },
      docsLink
    )
    const read = (editor: Editor) => ({
      json: editor.getJSON(),
      text: editor.getText(),
      domText: editor.view.dom.textContent,
      markdown: serializeToMarkdown(editor.getJSON()),
    })

    const decorated = openEditor(content)
    const plain = openEditor(content, { icons: false })

    expect({ icons: icons(decorated).length, ...read(decorated) }).toEqual({ icons: 2, ...read(plain) })
  })

  it("should draw favicons that load in the same frame with one redraw", () => {
    const editor = openEditor(paragraph(docsLink, { type: "text", text: " " }, link("b", "https://b.example.com/")))
    let redraws = 0
    editor.on("transaction", () => redraws++)

    settle(0, "load")
    settle(1, "load")
    const beforeFrame = icons(editor).map((icon) => icon.icon)
    vi.advanceTimersToNextFrame()

    expect({ beforeFrame, redraws, icons: icons(editor) }).toEqual({
      beforeFrame: ["globe", "globe"],
      redraws: 1,
      icons: [
        { link: "https://docs.example.com/a", icon: null, favicon: `url("${docsFavicon}")` },
        { link: "https://b.example.com/", icon: null, favicon: `url("${linkFaviconUrl("ws_1", "b.example.com")}")` },
      ],
    })
  })

  it("should not ask again for a failed favicon while its link stays in the text", () => {
    const editor = openEditor(paragraph(docsLink))

    settle(0, "error")
    vi.advanceTimersByTime(29_000)
    editor.commands.insertContentAt(1, "typing ")
    const requestedBeforeRetry = requestedFavicons()
    vi.advanceTimersByTime(1_000)
    settle(1, "error")
    vi.advanceTimersByTime(120_000)
    editor.commands.insertContentAt(1, "more typing ")

    expect({
      icons: icons(editor).map((icon) => icon.icon),
      requestedBeforeRetry,
      requested: requestedFavicons(),
    }).toEqual({
      icons: ["globe"],
      requestedBeforeRetry: [docsFavicon],
      requested: [docsFavicon, docsFavicon],
    })
  })

  it("should ask again for a failed favicon when its link returns after thirty seconds", () => {
    const editor = openEditor(paragraph(docsLink))
    const retype = () => {
      editor.commands.clearContent()
      editor.commands.setContent(paragraph(docsLink))
    }

    settle(0, "error")
    vi.advanceTimersByTime(29_000)
    retype()
    const requestedWithinWindow = requestedFavicons()
    vi.advanceTimersByTime(1_000)
    settle(1, "error")
    vi.advanceTimersByTime(30_000)
    retype()

    expect({ requestedWithinWindow, requested: requestedFavicons() }).toEqual({
      requestedWithinWindow: [docsFavicon],
      requested: [docsFavicon, docsFavicon, docsFavicon],
    })
  })

  it("should drop the timed retry when the link left the text or the editor closed", () => {
    const removed = openEditor(paragraph(docsLink))
    const closed = openEditor(paragraph(link("b", "https://b.example.com/")))

    settle(0, "error")
    settle(1, "error")
    removed.commands.clearContent()
    closed.destroy()
    vi.advanceTimersByTime(60_000)

    expect(requestedFavicons()).toEqual([docsFavicon, linkFaviconUrl("ws_1", "b.example.com")])
  })

  it("should request no favicon without a workspace", () => {
    const editor = openEditor(paragraph(docsLink), { workspaceId: null })

    expect({ icons: icons(editor), requested: requestedFavicons() }).toEqual({
      icons: [{ link: "https://docs.example.com/a", icon: "globe", favicon: null }],
      requested: [],
    })
  })

  it("should draw icons in the collaborative document editor", () => {
    const editor = mountEditor(createDocumentExtensions({ ydoc: new Y.Doc(), awareness: null, workspaceId: "ws_1" }))

    editor.commands.setContent(paragraph(link("pr", "https://github.com/threahq/threa/pull/1")))

    expect(icons(editor)).toEqual([{ link: "https://github.com/threahq/threa/pull/1", icon: "github", favicon: null }])
  })
})
