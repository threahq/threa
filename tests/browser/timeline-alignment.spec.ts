import { test, expect, type Locator, type Page } from "@playwright/test"
import { createChannel, expectApiOk, getActivePanel, loginAndCreateWorkspace } from "./helpers"

/**
 * Every timeline surface shares one reading column: rows inset their content by the timeline gutter
 * (12px phone, 24px from `sm`), and the floating composer and timeline cards sit on those same edges.
 * The composer is laid over the pane while the rows live in a scroller that reserves a scrollbar
 * gutter, so the two drift apart unless the composer insets by that gutter too.
 */

async function box(locator: Locator) {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error("element has no box")
  return { left: Math.round(rect.x), right: Math.round(rect.x + rect.width) }
}

/** The composer card spans the content edges of a message row in the same pane. */
async function expectComposerOnRowEdges(pane: Locator, gutter: number) {
  const row = await box(pane.locator(".message-item").first())
  const composer = await box(pane.locator("[data-composer-card]"))
  expect({ left: composer.left - row.left, right: row.right - composer.right }).toEqual({ left: gutter, right: gutter })
}

function sessionCard(scope: Locator) {
  return scope.getByText("Session complete").locator("xpath=ancestor::a[1]")
}

async function seedChannel(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "align")
  await createChannel(page, `align-${testId}`)
  const [, workspaceId, streamId] = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)!
  for (const content of ["A message in the channel", "@ariadne please say hi"]) {
    await expectApiOk(
      await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } }),
      `send ${content}`
    )
  }
  return { workspaceId, streamId }
}

test.describe("Timeline alignment", () => {
  test("composer and agent cards share the message column on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const { workspaceId, streamId } = await seedChannel(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)

    const main = page.getByRole("main")
    await expect(main.getByText("1 reply")).toBeVisible({ timeout: 30_000 })
    await expectComposerOnRowEdges(main, 24)

    await main.getByText("1 reply").click()
    const thread = getActivePanel(page)
    await expect(sessionCard(thread)).toBeVisible({ timeout: 15_000 })
    await expectComposerOnRowEdges(thread, 24)
    const row = await box(thread.locator(".message-item").first())
    const card = await box(sessionCard(thread))
    expect({ left: card.left - row.left, right: row.right - card.right }).toEqual({ left: 24, right: 24 })
  })

  test("a board card's agent session sits on the card's message edges", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const { workspaceId } = await seedChannel(page)
    await page.goto(`/w/${workspaceId}/board`)

    const boardCard = page.locator("[data-type-capture-scope]").filter({ has: page.getByText("Session complete") })
    await expect(sessionCard(boardCard)).toBeVisible({ timeout: 30_000 })
    const reply = await box(boardCard.getByText("Write a reply…").locator("xpath=ancestor::button[1]"))
    expect(await box(sessionCard(boardCard))).toEqual(reply)
  })

  test("composer shares the message column on a phone", async ({ page }) => {
    const { workspaceId, streamId } = await seedChannel(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/w/${workspaceId}/s/${streamId}`)

    const main = page.getByRole("main")
    await expect(main.locator(".message-item").first()).toBeVisible({ timeout: 30_000 })
    await expectComposerOnRowEdges(main, 12)
  })
})
