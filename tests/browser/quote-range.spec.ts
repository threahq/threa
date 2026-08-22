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

/**
 * Send a message whose body carries a bold run, so a selection that starts
 * inside the mark and ends outside it exercises a real slice.
 */
async function sendBoldMessage(page: Page, prefix: string, bold: string, suffix: string): Promise<string> {
  const { workspaceId, streamId } = workspaceAndStream(page)
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: {
      streamId,
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: prefix },
              { type: "text", text: bold, marks: [{ type: "bold" }] },
              { type: "text", text: suffix },
            ],
          },
        ],
      },
      contentMarkdown: `${prefix}**${bold}**${suffix}`,
    },
  })
  await expectApiOk(response, "Create bold source message")
  const body = (await response.json()) as { message?: { id: string } }
  return body.message?.id ?? ""
}

function mainMessageRow(page: Page, text: string): Locator {
  return page.getByRole("main").locator("[data-message-id]").filter({ hasText: text }).first()
}

/**
 * Put the browser's selection across a message body, from the start of `from`
 * through `to`'s first characters. Driven in the page because the quote toolbar
 * reads `window.getSelection()`, which Playwright's own APIs cannot set.
 */
async function selectAcross(page: Page, messageId: string, from: string, to: string): Promise<void> {
  await page.evaluate(
    ({ messageId, from, to }) => {
      const row = document.querySelector(`[data-message-id="${messageId}"]`)
      const body = row?.querySelector(".message-content .markdown-content")
      if (!body) throw new Error(`No rendered body for ${messageId}`)

      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      const textNodes: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text)

      const startNode = textNodes.find((node) => node.data.includes(from))
      const endNode = textNodes.find((node) => node.data.includes(to))
      if (!startNode || !endNode) throw new Error(`Could not locate "${from}" / "${to}" in the rendered body`)

      const range = document.createRange()
      range.setStart(startNode, startNode.data.indexOf(from))
      range.setEnd(endNode, endNode.data.indexOf(to) + to.length)

      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event("selectionchange"))
    },
    { messageId, from, to }
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
    await selectAcross(page, sourceId, "blocked", " until")

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
