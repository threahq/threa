import { test, expect, type Page, type Locator } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * Regression coverage for the composer clipboard roundtrip:
 *
 * 1. A message containing every block/chip style, sent, then "Copy as
 *    Markdown" → pasted into the composer → sent again must produce the
 *    identical markdown (parseMarkdown is a true inverse of
 *    serializeToMarkdown for the wire format).
 * 2. Copy/cut from the composer itself must put markdown on the clipboard
 *    (the editor's `clipboardTextSerializer`), so cut → paste restores the
 *    full document instead of flattening it to plain text.
 */

/**
 * Canonical wire-format markdown containing every style the composer can
 * hold: heading, inline marks, mention/channel pointer chips, emoji, fenced
 * code, nested bullet + ordered lists, a multi-paragraph blockquote, a
 * quote-reply chip, and a shared-message chip. Written as a
 * serializeToMarkdown fixed point so every roundtrip compares by string
 * equality.
 */
function buildCanonicalMarkdown(refs: { streamId: string; messageId: string; authorId: string }): string {
  return [
    "## Roundtrip heading",
    "",
    "**bold** *italic* ~~strike~~ `code` and [link](https://example.com)",
    "",
    "[@alice](user:usr_01ROUNDTRIP) and [#general](channel:stream_01ROUNDTRIP) 🎉",
    "",
    "```ts",
    "const x = 1",
    'console.log("hi")',
    "```",
    "",
    "- one",
    "- two",
    "  - nested",
    "- three",
    "",
    "1. first",
    "2. second",
    "",
    "> quoted one",
    "> quoted two",
    "",
    "> reply snippet",
    ">",
    `> — [Alice](quote:${refs.streamId}/${refs.messageId}/${refs.authorId}/user?v=1)`,
    "",
    `Shared a message from [Alice](shared-message:${refs.streamId}/${refs.messageId}?v=1)`,
    "",
    "tail paragraph",
  ].join("\n")
}

function composerEditor(page: Page): Locator {
  return page.getByRole("main").locator("[contenteditable='true']").first()
}

async function pastePlainText(page: Page, text: string): Promise<void> {
  await composerEditor(page).click()
  await page.evaluate((value) => {
    const editor = document.querySelector("main [contenteditable='true']")
    if (!editor) throw new Error("Editor not found")
    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", value)
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

/** Paste into the composer at wherever the caret already is, without clicking it first. */
async function pasteAtCaret(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const editor = document.querySelector("main [contenteditable='true']")
    if (!editor) throw new Error("Editor not found")
    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", value)
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

/**
 * Fire a synthetic copy/cut on the editor selection and return what the
 * editor wrote to `text/plain` — i.e. the output of the composer's
 * `clipboardTextSerializer`.
 */
async function captureEditorClipboard(page: Page, kind: "copy" | "cut"): Promise<string> {
  return page.evaluate((eventKind) => {
    const editor = document.querySelector("main [contenteditable='true']")
    if (!editor) throw new Error("Editor not found")
    const clipboardData = new DataTransfer()
    editor.dispatchEvent(new ClipboardEvent(eventKind, { clipboardData, bubbles: true, cancelable: true }))
    return clipboardData.getData("text/plain")
  }, kind)
}

/** Select an exact text run inside the composer via a DOM range (ProseMirror syncs from selectionchange). */
async function selectEditorText(page: Page, text: string): Promise<void> {
  await page.evaluate((needle) => {
    const editor = document.querySelector("main [contenteditable='true']")
    if (!editor) throw new Error("Editor not found")
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let current: Node | null
    while ((current = walker.nextNode())) {
      const index = (current.textContent ?? "").indexOf(needle)
      if (index === -1) continue
      const range = document.createRange()
      range.setStart(current, index)
      range.setEnd(current, index + needle.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      ;(editor as HTMLElement).focus()
      return
    }
    throw new Error(`Text not found in editor: ${needle}`)
  }, text)
}

/**
 * Collapse the selection to its end and wait for it to take. Pasting while a
 * selection still stands replaces it, so a test that means to paste *after* the
 * copied run has to land the caret first — `ArrowRight` races the DOM-range
 * selection ProseMirror is still reading.
 */
async function collapseSelectionToEnd(page: Page): Promise<void> {
  await page.evaluate(() => window.getSelection()?.collapseToEnd())
  await page.waitForFunction(() => window.getSelection()?.isCollapsed === true)
}

/** Every style from {@link buildCanonicalMarkdown}, asserted against the live editor DOM. */
async function expectEditorHasAllStyles(page: Page): Promise<void> {
  const editor = composerEditor(page)
  await expect(editor.locator("h2")).toHaveText("Roundtrip heading")
  await expect(editor.locator("strong")).toHaveText("bold")
  await expect(editor.locator("em")).toHaveText("italic")
  await expect(editor.locator("s")).toHaveText("strike")
  await expect(editor.locator("a[href='https://example.com']")).toHaveText("link")
  await expect(editor.locator("[data-id='usr_01ROUNDTRIP']")).toBeVisible()
  await expect(editor.locator("[data-id='stream_01ROUNDTRIP']")).toBeVisible()
  await expect(editor.locator("pre code")).toContainText('console.log("hi")')
  // Nested bullet list: "nested" sits inside a list within a list item.
  await expect(editor.locator("ul ul li")).toHaveText("nested")
  await expect(editor.locator("ol li")).toHaveCount(2)
  await expect(editor.locator("blockquote").first()).toContainText("quoted one")
  await expect(editor.locator("blockquote").first()).toContainText("quoted two")
  await expect(editor.locator("[data-type='quote-reply']")).toBeVisible()
  await expect(editor.locator("[data-type='shared-message']")).toBeVisible()
}

async function sendComposerContent(page: Page): Promise<void> {
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
  await expect(composerEditor(page)).not.toContainText("tail paragraph")
}

function sentMessageRows(page: Page): Locator {
  return page.getByRole("main").locator("[data-message-id]").filter({ hasText: "tail paragraph" })
}

async function copyMessageAsMarkdown(page: Page, row: Locator): Promise<string> {
  // Hover the row body (not the action pill area — resting on the pill's
  // other buttons pops their tooltips over the target), then click the
  // revealed actions button directly.
  await row.hover()
  const actionsButton = row.getByRole("button", { name: "Message actions" })
  await expect(actionsButton).toBeVisible()
  await actionsButton.click()
  await page.getByRole("menuitem", { name: "Copy as Markdown" }).click()
  return page.evaluate(() => navigator.clipboard.readText())
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

test.describe("Composer copy/paste roundtrip", () => {
  let canonicalMarkdown: string

  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "copy-roundtrip")
    const workspaceId = page.url().match(/\/w\/([^/]+)/)?.[1] ?? ""
    expect(workspaceId).not.toBe("")
    const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "scratchpad" },
    })
    await expectApiOk(response, "Create scratchpad")
    const body = (await response.json()) as { stream: { id: string } }
    const streamId = body.stream.id

    // The quote-reply and shared-message pointers must reference a message
    // that actually exists — the backend's share-recording step 400s
    // (SHARE_SOURCE_MESSAGE_NOT_FOUND) on a fabricated id. The body has to be
    // the quoted text too: the server derives a quote from the span it names in
    // the source, so a snippet that appears nowhere in it is refused. The seed
    // is never edited, so both pointers pin revision 1 and the canonical
    // markdown below is already the fixed point the roundtrip compares against.
    const seedResponse = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: {
        streamId,
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "reply snippet" }] }],
        },
        contentMarkdown: "reply snippet",
      },
    })
    await expectApiOk(seedResponse, "Send seed message")
    const seedBody = (await seedResponse.json()) as { message: { id: string; authorId: string } }
    canonicalMarkdown = buildCanonicalMarkdown({
      streamId,
      messageId: seedBody.message.id,
      authorId: seedBody.message.authorId,
    })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(composerEditor(page)).toBeVisible({ timeout: 10000 })
  })

  test("send → Copy as Markdown → paste → send preserves every style", async ({ page }) => {
    await pastePlainText(page, canonicalMarkdown)
    await expectEditorHasAllStyles(page)
    await sendComposerContent(page)

    // The send pipeline converts the pasted 🎉 into an emoji atom, whose wire
    // form is the shortcode — the one legitimate normalization in the cycle.
    // Everything else must come back byte-identical, and the shortcode form
    // is itself a fixed point (the second cycle returns it unchanged).
    const expectedSentMarkdown = canonicalMarkdown.replace("🎉", ":tada:")

    const firstRow = sentMessageRows(page).first()
    await expect(firstRow).toBeVisible({ timeout: 10000 })
    const copiedMarkdown = await copyMessageAsMarkdown(page, firstRow)
    expect(copiedMarkdown).toBe(expectedSentMarkdown)

    await pastePlainText(page, copiedMarkdown)
    await expectEditorHasAllStyles(page)
    await sendComposerContent(page)

    const secondRow = sentMessageRows(page).nth(1)
    await expect(secondRow).toBeVisible({ timeout: 10000 })
    const secondMarkdown = await copyMessageAsMarkdown(page, secondRow)
    expect(secondMarkdown).toBe(expectedSentMarkdown)
  })

  test("copy and cut from the composer serialize the selection to markdown", async ({ page }) => {
    await pastePlainText(page, canonicalMarkdown)
    await expectEditorHasAllStyles(page)

    // Partial (single-block) selection: the slice arrives inline-wrapped in
    // its parent block, and the marks must survive — this was the everyday
    // copy shape the old container copy handler serialized to "".
    let partial = ""
    await expect(async () => {
      await selectEditorText(page, "bold")
      partial = await captureEditorClipboard(page, "copy")
      expect(partial).not.toBe("")
    }).toPass({ timeout: 10000 })
    expect(partial).toBe("**bold**")

    // Click a text block (not the editor's center, which can land on an
    // atom chip and swallow focus), then select-all through the editor.
    // Retried because the click can race the editor settling after paste,
    // leaving the caret (and thus the selection) empty.
    // Control (not ControlOrMeta): the suite's Desktop Chrome device emulates
    // Linux, so ProseMirror binds select-all to Ctrl-A — the host-resolved
    // Meta+A would be selected natively by the browser without ProseMirror's
    // state ever seeing it, and the copy handler reads the state selection.
    // Copy is non-destructive, so the whole select-all → copy sequence
    // retries as a unit until ProseMirror's state selection has caught up
    // (the DOM selection can briefly lead it after the click).
    let copied = ""
    await expect(async () => {
      await composerEditor(page).locator("h2").click()
      await page.keyboard.press("Control+a")
      copied = await captureEditorClipboard(page, "copy")
      expect(copied).not.toBe("")
    }).toPass({ timeout: 10000 })
    expect(copied).toBe(canonicalMarkdown)
    // Copy must not disturb the document.
    await expectEditorHasAllStyles(page)

    const cut = await captureEditorClipboard(page, "cut")
    expect(cut).toBe(canonicalMarkdown)
    await expect(composerEditor(page)).not.toContainText("tail paragraph")

    // Paste the cut markdown back — the full document must come back.
    await pastePlainText(page, cut)
    await expectEditorHasAllStyles(page)
  })

  /**
   * Copying from strictly inside a block must not carry that block's own
   * markdown: the fence/quote marker/bullet belongs to text the selection
   * never touched, and pasting it back into the block wrote it out literally.
   */
  test("copying from inside a code block copies bare and pastes back without a fence", async ({ page }) => {
    await pastePlainText(page, "```plaintext\n> Hi there\n```")
    const editor = composerEditor(page)
    await expect(editor.locator("pre code")).toHaveText("> Hi there")

    let copied = ""
    await expect(async () => {
      await selectEditorText(page, "there")
      copied = await captureEditorClipboard(page, "copy")
      expect(copied).not.toBe("")
    }).toPass({ timeout: 10000 })
    expect(copied).toBe("there")

    // Paste at the end of the copied run — still inside the code block — the
    // move the fence used to break.
    await collapseSelectionToEnd(page)
    await pasteAtCaret(page, copied)

    await expect(editor.locator("pre code")).toHaveText("> Hi therethere")
    await expect(editor.locator("pre")).toHaveCount(1)
  })

  test("copying from inside a quote copies bare", async ({ page }) => {
    await pastePlainText(page, "> quoted line")
    await expect(composerEditor(page).locator("blockquote")).toContainText("quoted line")

    let copied = ""
    await expect(async () => {
      await selectEditorText(page, "quoted")
      copied = await captureEditorClipboard(page, "copy")
      expect(copied).not.toBe("")
    }).toPass({ timeout: 10000 })
    expect(copied).toBe("quoted")
  })

  /**
   * Paste-without-formatting must land the text, not the markdown that carries
   * its styling — the clipboard's `text/plain` flavour is markdown, and it used
   * to be inserted literally.
   */
  test("pasting without formatting strips the styling instead of writing markdown", async ({ page }) => {
    await pastePlainText(page, "**bold words** tail")
    const editor = composerEditor(page)
    await expect(editor.locator("strong")).toHaveText("bold words")

    let copied = { html: "", text: "" }
    await expect(async () => {
      await selectEditorText(page, "bold words")
      copied = await page.evaluate(() => {
        const target = document.querySelector("main [contenteditable='true']")
        if (!target) throw new Error("Editor not found")
        const clipboardData = new DataTransfer()
        target.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }))
        return { html: clipboardData.getData("text/html"), text: clipboardData.getData("text/plain") }
      })
      expect(copied.text).toBe("**bold words**")
    }).toPass({ timeout: 10000 })

    await collapseSelectionToEnd(page)

    // ProseMirror reads the shift key off the last keydown to decide a paste is
    // plain; the composer's handler reads the same flag.
    await page.evaluate((flavours) => {
      const target = document.querySelector("main [contenteditable='true']")
      if (!target) throw new Error("Editor not found")
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "v", shiftKey: true, bubbles: true, cancelable: true }))
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/html", flavours.html)
      clipboardData.setData("text/plain", flavours.text)
      target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
    }, copied)

    await expect(editor).toHaveText("bold wordsbold words tail")
    await expect(editor.locator("strong")).toHaveCount(1)
  })

  test("copying part of a mark run drops the mark, the whole run keeps it", async ({ page }) => {
    await pastePlainText(page, "**bold words** tail")
    await expect(composerEditor(page).locator("strong")).toHaveText("bold words")

    let partial = ""
    await expect(async () => {
      await selectEditorText(page, "words")
      partial = await captureEditorClipboard(page, "copy")
      expect(partial).not.toBe("")
    }).toPass({ timeout: 10000 })
    expect(partial).toBe("words")

    let whole = ""
    await expect(async () => {
      await selectEditorText(page, "bold words")
      whole = await captureEditorClipboard(page, "copy")
      expect(whole).not.toBe("")
    }).toPass({ timeout: 10000 })
    expect(whole).toBe("**bold words**")
  })
})
