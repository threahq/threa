import { test, expect, type Page } from "@playwright/test"
import { createChannel, expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * A long-press action sheet scrolls vertically and nothing else. Its scroller
 * is `overflow-y: auto`, which makes the other axis scrollable too, so one row
 * wider than the sheet lets the whole list slide sideways under a thumb. Only
 * a layout engine knows whether a row overflows.
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 844 }

async function longPress(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox()
  expect(box).toBeTruthy()
  const touch = { identifier: 1, clientX: box!.x + box!.width / 2, clientY: box!.y + 12 }
  await page.dispatchEvent(selector, "touchstart", {
    touches: [touch],
    changedTouches: [touch],
    targetTouches: [touch],
  })
  await page.waitForTimeout(700)
  await page.dispatchEvent(selector, "touchend", { touches: [], changedTouches: [], targetTouches: [] })
}

/** Every scroller in the open sheet that can move sideways, as `class: overflow px`. */
async function sidewaysScrollers(page: Page): Promise<string[]> {
  const sheet = page.locator("[data-vaul-drawer]")
  await expect(sheet).toBeVisible({ timeout: 10_000 })
  await expect(sheet.locator('[data-orientation="horizontal"]').first()).toBeAttached()
  return sheet.evaluate((drawer) =>
    [drawer, ...drawer.querySelectorAll<HTMLElement>("*")]
      .filter((el) => ["auto", "scroll"].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth)
      .map((el) => `${el.className}: ${el.scrollWidth - el.clientWidth}px`)
  )
}

test("the message and sidebar action sheets do not scroll sideways", async ({ page: setupPage, browser }) => {
  await loginAndCreateWorkspace(setupPage, "sheet-overflow")
  await createChannel(setupPage, `sheet-${Date.now().toString(36)}`)
  const [, workspaceId, streamId] = setupPage.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)!
  const body = "A message to long-press."
  const response = await setupPage.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: {
      streamId,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] },
      contentMarkdown: body,
    },
  })
  await expectApiOk(response, "Create the message to long-press")

  const context = await browser.newContext({
    storageState: await setupPage.context().storageState(),
    hasTouch: true,
    viewport: PHONE,
  })
  const page = await context.newPage()
  await page.goto(setupPage.url())

  await expect(page.locator("[data-message-id]").first()).toBeVisible({ timeout: 30_000 })
  await longPress(page, "[data-message-id] .message-content")
  const messageSheet = await sidewaysScrollers(page)

  await page.keyboard.press("Escape")
  await expect(page.locator("[data-vaul-drawer]")).toBeHidden({ timeout: 10_000 })
  const sidebarRow = `[aria-label="Sidebar navigation"] a[href$="/s/${streamId}"]`
  if (!(await page.locator(sidebarRow).first().isVisible())) {
    await page
      .getByRole("button", { name: /sidebar/i })
      .first()
      .click()
  }
  await page.locator(sidebarRow).first().scrollIntoViewIfNeeded()
  await longPress(page, sidebarRow)
  const sidebarSheet = await sidewaysScrollers(page)

  expect({ messageSheet, sidebarSheet }).toEqual({ messageSheet: [], sidebarSheet: [] })
})
