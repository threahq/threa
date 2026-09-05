import { test, expect, type Locator, type Page } from "@playwright/test"
import { createChannel, expectApiOk, generateTestId, loginAndCreateWorkspace } from "./helpers"

/**
 * E2E coverage for inline `shared-message:`/`quote:` links inside stored
 * markdown — the step-2 renderer contract. Complements the mounted
 * `inline-message-pointer.test.tsx` unit suite with real-product proof:
 *
 * 1. An inline shared-message link with an author label navigates in-app to
 *    the source message permalink (native anchor click, no custom protocol).
 * 2. A repaired bare `msg_<ULID>` label renders the generic "Message" chip —
 *    never the raw id — and the chip navigates too.
 * 3. The canonical own-line share card is untouched: the exact serializer
 *    shape still renders as the hydrated `[data-type='shared-message']`
 *    card, not an inline link.
 */

async function sendMarkdownMessageViaApi(page: Page, contentMarkdown: string): Promise<string> {
  const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
  expect(match).toBeTruthy()
  const [, workspaceId, streamId] = match!
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: {
      streamId,
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: contentMarkdown }] }],
      },
      contentMarkdown,
    },
  })
  await expectApiOk(response, `Create markdown message: ${contentMarkdown}`)
  const body = (await response.json()) as { message?: { id: string } }
  return body.message?.id ?? ""
}

function mainMessageRow(page: Page, text: string): Locator {
  return page.getByRole("main").locator("[data-message-id]").filter({ hasText: text }).first()
}

test.describe("Inline shared-message pointer navigation", () => {
  let testId: string

  test.beforeEach(async ({ page }) => {
    testId = (await loginAndCreateWorkspace(page, "inline-pointer")).testId
  })

  test("navigates an inline shared-message link with its author label in-app", async ({ page }) => {
    const channelName = `ptr-${testId}`
    await createChannel(page, channelName, { switchToAll: false })
    const sourceText = `source-${testId}`
    const sourceId = await sendMarkdownMessageViaApi(page, sourceText)
    const [, workspaceId, sourceStreamId] = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)!

    // The source message must be visible in this stream before anything can
    // point at it — wait for the row so the pointer card hydrates instantly.
    await expect(mainMessageRow(page, sourceText)).toBeVisible()

    const pointerText = `pointer-${testId}`
    await sendMarkdownMessageViaApi(
      page,
      `See [Source message](shared-message:${sourceStreamId}/${sourceId}) for context. (${pointerText})`
    )
    const pointerRow = mainMessageRow(page, pointerText)
    await expect(pointerRow).toBeVisible()

    // The pointer renders as a real anchor carrying the in-app permalink.
    const link = pointerRow.getByRole("link", { name: "Source message" })
    await expect(link).toHaveAttribute("href", `/w/${workspaceId}/s/${sourceStreamId}?m=${sourceId}`)

    await link.click()
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/s/${sourceStreamId}\\?m=${sourceId}`))
  })

  test("shows a generic Message label for a bare repaired message id and still navigates", async ({ page }) => {
    const channelName = `bare-${testId}`
    await createChannel(page, channelName, { switchToAll: false })
    const sourceText = `bare-source-${testId}`
    const sourceId = await sendMarkdownMessageViaApi(page, sourceText)
    const [, workspaceId, sourceStreamId] = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)!

    const pointerText = `bare-pointer-${testId}`
    await sendMarkdownMessageViaApi(page, `[${sourceId}](shared-message:${sourceStreamId}/${sourceId}) ${pointerText}`)
    const pointerRow = mainMessageRow(page, pointerText)
    await expect(pointerRow).toBeVisible({ timeout: 5000 })

    // The raw ULID must never be visible as the link label — pending shows
    // the generic "Message" label; once resolved the chip names the author in
    // context. Either way the anchor carries the permalink.
    await expect(pointerRow.getByText(sourceId)).toHaveCount(0)
    const link = pointerRow.locator(`a[href="/w/${workspaceId}/s/${sourceStreamId}?m=${sourceId}"]`)
    await expect(link).toBeVisible()

    await link.click()
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/s/${sourceStreamId}\\?m=${sourceId}`))
  })

  test("keeps the canonical own-line shared-message card a card", async ({ page }) => {
    const channelName = `card-${testId}`
    await createChannel(page, channelName, { switchToAll: false })
    const sourceText = `card-source-${testId}`
    const sourceId = await sendMarkdownMessageViaApi(page, sourceText)
    const [, , sourceStreamId] = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)!

    // The exact serializer shape for an own-line share: prefix text plus a
    // single anchor, nothing else on the line.
    const cardText = `card-pointer-${testId}`
    await sendMarkdownMessageViaApi(
      page,
      `Shared a message from [Author](shared-message:${sourceStreamId}/${sourceId})\n\n${cardText}`
    )
    const pointerRow = mainMessageRow(page, cardText)
    await expect(pointerRow).toBeVisible({ timeout: 5000 })

    // Walk back one message: the share must render as the pointer card
    // element, not an inline underlined link.
    const card = page.locator("[data-type='shared-message']").first()
    await expect(card).toBeVisible()
    await expect(card.locator("a").filter({ hasText: "Author" })).toHaveCount(0)
  })
})
