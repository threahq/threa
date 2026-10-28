import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import * as Y from "yjs"
import { updateYFragment } from "y-prosemirror"
import { getThreaSchema } from "@threahq/prosemirror/schema"
import { DOC_FRAGMENT, type JSONContent } from "@threahq/types"
import { render, screen, userEvent, waitFor } from "@/test"
import { SidebarActionMenu } from "@/components/layout/sidebar/sidebar-actions"
import { docExportActions, docMarkdown, docMarkdownFilename } from "./doc-export-actions"

function docWith(...blocks: JSONContent[]): Y.Doc {
  const ydoc = new Y.Doc()
  const node = getThreaSchema().nodeFromJSON({ type: "doc", content: blocks })
  updateYFragment(ydoc, ydoc.getXmlFragment(DOC_FRAGMENT), node, { mapping: new Map(), isOMark: new Map() })
  return ydoc
}

const owners: JSONContent = {
  type: "paragraph",
  attrs: { blockId: "blk_0000000000000000000000000A" },
  content: [
    { type: "text", text: "Owners and " },
    { type: "text", text: "dates", marks: [{ type: "bold" }] },
  ],
}

/** jsdom's Blob has no `text()`. */
function readText(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsText(blob)
  })
}

async function pick(ydoc: Y.Doc, title: string | null, label: string, submenu?: string) {
  render(
    <MemoryRouter>
      <SidebarActionMenu actions={docExportActions(ydoc, title)} ariaLabel="Stream actions" />
    </MemoryRouter>
  )
  await userEvent.click(screen.getByRole("button", { name: "Stream actions" }))
  if (submenu) await userEvent.click(await screen.findByRole("menuitem", { name: submenu }))
  await userEvent.click(await screen.findByRole("menuitem", { name: label }))
}

describe("doc export", () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const writeText = vi.fn()

  beforeEach(() => {
    vi.restoreAllMocks()
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  })

  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
    else delete (navigator as { clipboard?: Clipboard }).clipboard
  })

  it("should put the title above the body, and leave an untitled doc without a heading", () => {
    const ydoc = docWith(owners)
    expect({ titled: docMarkdown(ydoc, "Launch plan"), untitled: docMarkdown(ydoc, null) }).toEqual({
      titled: "# Launch plan\n\nOwners and **dates**",
      untitled: "Owners and **dates**",
    })
  })

  it("should name the file after the title, with characters a file system rejects replaced", () => {
    expect([
      docMarkdownFilename("Launch: plan/v2"),
      docMarkdownFilename("..hidden"),
      docMarkdownFilename(' <*?"> '),
      docMarkdownFilename("v2. "),
      docMarkdownFilename(null),
    ]).toEqual(["Launch plan v2.md", "hidden.md", "Untitled.md", "v2.md", "Untitled.md"])
  })

  it("should copy the doc as Markdown from its menu", async () => {
    await pick(docWith(owners), "Launch plan", "Copy as Markdown")

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Launch plan\n\nOwners and **dates**"))
  })

  it("should copy the doc as plain text from its menu", async () => {
    await pick(docWith(owners), "Launch plan", "Copy as Plain text", "Copy as Markdown options")

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Launch plan\n\nOwners and dates"))
  })

  it("should download the doc as a Markdown file named after its title", async () => {
    const blobs: Blob[] = []
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return "blob:doc"
    })
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const downloads: { href: string; download: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.getAttribute("href") ?? "", download: this.download })
    })

    await pick(docWith(owners), "Launch: plan/v2", "Download as Markdown")

    await waitFor(() => expect(downloads).toEqual([{ href: "blob:doc", download: "Launch plan v2.md" }]))
    expect({ type: blobs[0]?.type, text: await readText(blobs[0]) }).toEqual({
      type: "text/markdown;charset=utf-8",
      text: "# Launch: plan/v2\n\nOwners and **dates**",
    })
  })
})
