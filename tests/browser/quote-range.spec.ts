import { test, expect, type Locator, type Page } from "@playwright/test"
import { createChannel, expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * E2E coverage for quoting part of a message. The contract the plan sets:
 * a selection-driven quote is pinned to the revision the reader saw and to the
 * span they highlighted, and the stored snippet is the formatted slice of that
 * span — not the flat string the DOM handed us. Legacy quotes, which carry no
 * pin, must keep working: the server locates their snippet and pins them.
 */

interface QuoteAttrs {
  messageId: string
  snippet: string
  version: number | null
  range: { from: number; to: number } | null
}

function workspaceAndStream(page: Page): { workspaceId: string; streamId: string } {
  const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
  expect(match, "workspace + stream should be resolvable from the URL").toBeTruthy()
  return { workspaceId: match![1], streamId: match![2] }
}

async function sendMessage(page: Page, content: unknown[], contentMarkdown: string): Promise<string> {
  const { workspaceId, streamId } = workspaceAndStream(page)
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, contentJson: { type: "doc", content }, contentMarkdown },
  })
  await expectApiOk(response, "Create message")
  const body = (await response.json()) as { message?: { id: string } }
  return body.message?.id ?? ""
}

/**
 * Send a message whose body carries a bold run, so a selection that starts
 * inside the mark and ends outside it exercises a real slice.
 */
function sendBoldMessage(page: Page, prefix: string, bold: string, suffix: string): Promise<string> {
  const paragraph = {
    type: "paragraph",
    content: [
      { type: "text", text: prefix },
      { type: "text", text: bold, marks: [{ type: "bold" }] },
      { type: "text", text: suffix },
    ],
  }
  return sendMessage(page, [paragraph], `${prefix}**${bold}**${suffix}`)
}

function sendParagraphs(page: Page, paragraphs: string[]): Promise<string> {
  const content = paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] }))
  return sendMessage(page, content, paragraphs.join("\n\n"))
}

function mainMessageRow(page: Page, text: string): Locator {
  return page.getByRole("main").locator("[data-message-id]").filter({ hasText: text }).first()
}

interface SelectionEnd {
  messageId: string
  text: string
}

/**
 * Put the browser's selection from the start of `from.text` through the end of
 * `to.text`, each found in its message's rendered body. Driven in the page
 * because the quote toolbar reads `window.getSelection()`, which Playwright's
 * own APIs cannot set.
 */
async function selectAcross(page: Page, from: SelectionEnd, to: SelectionEnd): Promise<void> {
  await page.evaluate(
    ({ from, to }) => {
      const textNodeWith = ({ messageId, text }: SelectionEnd): Text => {
        const body = document.querySelector(`[data-message-id="${messageId}"] .message-content .markdown-content`)
        if (!body) throw new Error(`No rendered body for ${messageId}`)

        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node as Text).data.includes(text)) return node as Text
        }
        throw new Error(`Could not locate "${text}" in ${messageId}`)
      }

      const startNode = textNodeWith(from)
      const endNode = textNodeWith(to)
      const range = document.createRange()
      range.setStart(startNode, startNode.data.indexOf(from.text))
      range.setEnd(endNode, endNode.data.indexOf(to.text) + to.text.length)

      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event("selectionchange"))
    },
    { from, to }
  )
}

/**
 * The quote node stored on the message whose body contains `marker`.
 *
 * Polled: the row is on screen as soon as it renders optimistically, which is
 * before the server has the event, so a single read races the send.
 */
async function storedQuoteAttrs(page: Page, marker: string): Promise<QuoteAttrs> {
  const { workspaceId, streamId } = workspaceAndStream(page)

  const readQuotes = async (): Promise<QuoteAttrs[] | null> => {
    const response = await page.request.get(`/api/workspaces/${workspaceId}/streams/${streamId}/events?limit=100`)
    if (!response.ok()) return null
    const body = (await response.json()) as {
      events: Array<{ eventType: string; payload?: { contentMarkdown?: string; contentJson?: unknown } }>
    }
    const event = body.events.find(
      (candidate) => candidate.eventType === "message_created" && candidate.payload?.contentMarkdown?.includes(marker)
    )
    if (!event) return null

    const found: QuoteAttrs[] = []
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return
      const typed = node as { type?: string; attrs?: QuoteAttrs; content?: unknown[] }
      if (typed.type === "quoteReply" && typed.attrs) found.push(typed.attrs)
      for (const child of typed.content ?? []) walk(child)
    }
    walk(event.payload?.contentJson)
    return found
  }

  await expect
    .poll(async () => (await readQuotes())?.length ?? 0, {
      timeout: 10000,
      message: `stored message carrying "${marker}" with exactly one quote node`,
    })
    .toBe(1)

  return (await readQuotes())![0]
}

test.describe("Quote by range", () => {
  test("quotes the highlighted span, pinned to the revision on screen", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "quote-range")
    await createChannel(page, `qr-${testId}`, { switchToAll: false })

    const sourceText = `deploy-${testId}`
    const sourceId = await sendBoldMessage(page, `${sourceText} is `, "blocked", " until friday")
    await expect(mainMessageRow(page, sourceText)).toBeVisible({ timeout: 10000 })

    // Keep the app in mouse mode — the floating quote button is mouse-only.
    await page.mouse.move(10, 10)
    await selectAcross(page, { messageId: sourceId, text: "blocked" }, { messageId: sourceId, text: " until" })

    const quoteButton = page.getByRole("button", { name: /^quote$/i })
    await expect(quoteButton).toBeVisible({ timeout: 10000 })
    await quoteButton.click()

    // The composer chip shows the slice, stripped to inline text (INV-60).
    const composer = page.locator("[contenteditable='true']").first()
    const chip = composer.locator("[data-type='quote-reply']")
    await expect(chip).toHaveCount(1, { timeout: 10000 })
    await expect(chip).toContainText("blocked until")
    await expect(chip).not.toContainText("**")

    const marker = `reply-${testId}`
    await composer.focus()
    await page.keyboard.type(marker)
    await page.keyboard.press("Enter")

    await expect(mainMessageRow(page, marker)).toBeVisible({ timeout: 10000 })

    const attrs = await storedQuoteAttrs(page, marker)
    expect(attrs.messageId).toBe(sourceId)
    expect(attrs.version).toBe(1)
    expect(attrs.range).not.toBeNull()
    expect(attrs.range!.to).toBeGreaterThan(attrs.range!.from)
    // The span, formatted — a flat DOM string would have lost the bold run.
    expect(attrs.snippet).toContain("**blocked**")
    expect(attrs.snippet).not.toContain("friday")

    // Rendered back into the timeline as a quote card carrying the bold word.
    const quotedRow = mainMessageRow(page, marker)
    await expect(quotedRow.locator("strong").filter({ hasText: "blocked" })).toBeVisible()
  })

  test("triple-clicking a message's last paragraph offers the quote; a selection reaching the next message does not", async ({
    page,
  }) => {
    const { testId } = await loginAndCreateWorkspace(page, "quote-triple")
    await createChannel(page, `qt-${testId}`, { switchToAll: false })

    const opening = `opening-${testId} sets the scene.`
    const closing = `closing-${testId} is the question to quote.`
    const followUp = `followup-${testId} arrives next.`
    const sourceId = await sendParagraphs(page, [opening, closing])
    const nextId = await sendParagraphs(page, [followUp])
    await expect(mainMessageRow(page, followUp)).toBeVisible({ timeout: 10000 })

    // Chromium ends a triple-click on a body's last block at the start of the
    // next row, outside the body.
    await page.locator(`[data-message-id="${sourceId}"] p`).filter({ hasText: closing }).click({ clickCount: 3 })
    const quoteButton = page.getByRole("button", { name: /^quote$/i })
    await expect(quoteButton).toBeVisible({ timeout: 10000 })
    await quoteButton.click()

    const chip = page.locator("[contenteditable='true']").first().locator("[data-type='quote-reply']")
    await expect(chip).toHaveCount(1, { timeout: 10000 })
    await expect(chip).toContainText(closing)
    await expect(chip).not.toContainText(opening)

    // Visible first, so hiding is the selection reaching past the body.
    await selectAcross(page, { messageId: sourceId, text: "opening" }, { messageId: sourceId, text: "scene" })
    await expect(quoteButton).toBeVisible()

    await selectAcross(page, { messageId: sourceId, text: "opening" }, { messageId: nextId, text: "followup" })
    await expect(quoteButton).toBeHidden()
  })

  test("still renders a legacy quote sent without a version or range", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "quote-legacy")
    await createChannel(page, `ql-${testId}`, { switchToAll: false })

    const sourceText = `legacy-${testId}`
    const sourceId = await sendBoldMessage(page, `${sourceText} is `, "blocked", " until friday")
    await expect(mainMessageRow(page, sourceText)).toBeVisible({ timeout: 10000 })

    const { workspaceId, streamId } = workspaceAndStream(page)
    const marker = `legacy-reply-${testId}`
    const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: {
        streamId,
        contentJson: {
          type: "doc",
          content: [
            {
              type: "quoteReply",
              // Exactly what a client shipped before pins existed: a plain-text
              // snippet, no version, no range.
              attrs: {
                messageId: sourceId,
                streamId,
                authorName: "",
                authorId: "",
                actorType: "user",
                snippet: "blocked until",
              },
            },
            { type: "paragraph", content: [{ type: "text", text: marker }] },
          ],
        },
        contentMarkdown: `> blocked until\n\n${marker}`,
      },
    })
    await expectApiOk(response, "Create legacy quote message")

    const row = mainMessageRow(page, marker)
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row.locator("strong").filter({ hasText: "blocked" })).toBeVisible()

    // The server located the snippet and pinned it, so the legacy node is no
    // longer unpinned once stored.
    const attrs = await storedQuoteAttrs(page, marker)
    expect(attrs.version).toBe(1)
    expect(attrs.range).not.toBeNull()
  })
})
