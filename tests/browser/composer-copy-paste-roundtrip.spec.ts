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
    `> — [Alice](quote:${refs.streamId}/${refs.messageId}/${refs.authorId}/user)`,
    "",
    `Shared a message from [Alice](shared-message:${refs.streamId}/${refs.messageId})`,
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
    // (SHARE_SOURCE_MESSAGE_NOT_FOUND) on a fabricated id.
    const seedResponse = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: {
        streamId,
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "seed" }] }] },
        contentMarkdown: "seed",
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
})
