import { test, expect, type Locator, type Page } from "@playwright/test"
import { createChannel, expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * E2E coverage for sharing part of a message. A share pins the revision the
 * sharer had on screen and the span they highlighted, so the card keeps
 * rendering that span after the source moves on — and says the source moved on
 * rather than quietly rewriting what was shared.
 */

function workspaceAndStream(page: Page): { workspaceId: string; streamId: string } {
  const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
  expect(match, "workspace + stream should be resolvable from the URL").toBeTruthy()
  return { workspaceId: match![1], streamId: match![2] }
}

/** A body with a bold run, so a span across the mark exercises a real slice. */
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
 * through `to`. Driven in the page because the selection toolbar reads
 * `window.getSelection()`, which Playwright's own APIs cannot set.
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

test.describe("Share by range", () => {
  test("shares the highlighted span and holds it when the source is edited", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "share-range")
    const channelName = `sr-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    const sourceText = `deploy-${testId}`
    const sourceId = await sendBoldMessage(page, `${sourceText} is `, "blocked", " until friday")
    await expect(mainMessageRow(page, sourceText)).toBeVisible({ timeout: 10000 })

    // Keep the app in mouse mode — the floating toolbar is mouse-only.
    await page.mouse.move(10, 10)
    await selectAcross(page, sourceId, "blocked", " until")

    const shareButton = page.getByRole("button", { name: "Share", exact: true })
    await expect(shareButton).toBeVisible({ timeout: 10000 })
    await shareButton.click()

    // The picker previews exactly what will be shared: the span, not the body.
    const dialog = page.getByRole("dialog", { name: /share message/i })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("blocked until")
    await expect(dialog).not.toContainText("friday")

    // Share back into the same channel so both the source and the card are on
    // one timeline (D5 allows a same-stream share).
    const sameChannel = dialog
      .locator("[cmdk-item][data-value]")
      .filter({ hasText: new RegExp(channelName, "i") })
      .first()
    await expect(sameChannel).toBeVisible()
    await sameChannel.click()

    const composer = page.locator("[contenteditable='true']").first()
    await expect(composer.locator("[data-type='shared-message']")).toHaveCount(1, { timeout: 10000 })
    await composer.focus()
    await page.keyboard.press("Enter")

    const card = page.getByRole("main").locator("[data-type='shared-message']").filter({ hasText: "blocked" }).first()
    await expect(card).toBeVisible({ timeout: 10000 })
    // Only the slice, formatted — the rest of the source never reaches the card.
    await expect(card.locator("strong").filter({ hasText: "blocked" })).toBeVisible()
    await expect(card).not.toContainText("friday")
    await expect(card.getByText(/edited since/i)).toHaveCount(0)

    // Edit the source. The card is pinned to the revision that was shared, so
    // it keeps the span and picks up the marker instead of rewriting itself.
    const { workspaceId } = workspaceAndStream(page)
    const editedText = `rescheduled-${testId}`
    const editResponse = await page.request.patch(`/api/workspaces/${workspaceId}/messages/${sourceId}`, {
      data: {
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: editedText }] }] },
        contentMarkdown: editedText,
      },
    })
    await expectApiOk(editResponse, `Edit source message ${sourceId}`)

    await expect(card.getByText(/edited since/i)).toBeVisible({ timeout: 10000 })
    await expect(card).toContainText("blocked until")
    await expect(card).not.toContainText(editedText)
  })
})
