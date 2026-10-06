import { test, expect, type Locator, type Page } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * Timeline row overlays mount only on first interaction (`components/ui/lazy-overlay.tsx`),
 * which swaps the trigger node under the pointer. jsdom has no hit testing, so
 * whether a real browser still opens, and closes, them is proved here.
 */

test.setTimeout(120_000)

async function center(locator: Locator) {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function setup(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "lazy-overlay")
  await createChannel(page, `lazy-overlay-${testId}`)
  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  const text = `row ${testId}`
  await page.keyboard.type(text)
  await page.keyboard.press("Meta+Enter")
  const row = page.getByRole("main").locator(".message-item").filter({ hasText: text }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  // The optimistic row settles into the confirmed one before anything is hovered.
  await expect(row.getByRole("link", { name: "Reply in thread" })).toBeAttached({ timeout: 10_000 })
  await page.waitForTimeout(500)
  // Park the pointer on the row's text so the toolbar is revealed.
  const rowBox = (await row.boundingBox())!
  await page.mouse.move(rowBox.x + 40, rowBox.y + rowBox.height / 2, { steps: 4 })
  return row
}

const away = { x: 5, y: 400 }

test("tooltip opens on a real hover and closes on leave", async ({ page }) => {
  const row = await setup(page)
  const quote = row.getByRole("button", { name: "Quote reply" })
  const c = await center(quote)
  await page.mouse.move(c.x, c.y, { steps: 6 })
  await expect(page.getByRole("tooltip", { name: "Quote reply" })).toBeVisible({ timeout: 3000 })
  await page.mouse.move(away.x, away.y, { steps: 6 })
  await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: 3000 })
})

test("tooltip opens when the pointer rests after a single entry move", async ({ page }) => {
  const row = await setup(page)
  const quote = row.getByRole("button", { name: "Quote reply" })
  const c = await center(quote)
  await page.mouse.move(c.x, c.y)
  await expect(page.getByRole("tooltip", { name: "Quote reply" })).toBeVisible({ timeout: 3000 })
})

test("a fast sweep across triggers leaves nothing open", async ({ page }) => {
  const row = await setup(page)
  const quote = await center(row.getByRole("button", { name: "Quote reply" }))
  const save = await center(row.getByRole("button", { name: "Save for later" }))
  await page.mouse.move(save.x, save.y)
  await page.mouse.move(quote.x, quote.y)
  await page.mouse.move(away.x, away.y)
  await page.waitForTimeout(1000)
  await expect(page.getByRole("tooltip")).toHaveCount(0)
  await expect(page.locator("[data-radix-popper-content-wrapper]")).toHaveCount(0)
})

test("save hover card opens once and closes on leave", async ({ page }) => {
  const row = await setup(page)
  const save = row.getByRole("button", { name: "Save for later" })
  const c = await center(save)
  await page.mouse.move(c.x, c.y, { steps: 6 })
  const card = page.locator("[data-radix-popper-content-wrapper]").filter({ hasText: "In 15 minutes" })
  await expect(card).toBeVisible({ timeout: 3000 })
  await page.mouse.move(away.x, away.y, { steps: 6 })
  await expect(card).toHaveCount(0, { timeout: 3000 })
})

test("save hover card: a pass shorter than its open delay stays closed", async ({ page }) => {
  const row = await setup(page)
  const c = await center(row.getByRole("button", { name: "Save for later" }))
  await page.mouse.move(c.x, c.y)
  await page.waitForTimeout(50)
  await page.mouse.move(away.x, away.y)
  await page.waitForTimeout(800)
  await expect(page.locator("[data-radix-popper-content-wrapper]")).toHaveCount(0)
})

test("keyboard focus arms and opens the tooltip", async ({ page }) => {
  const row = await setup(page)
  const quote = row.getByRole("button", { name: "Quote reply" })
  await page.mouse.move(away.x, away.y)
  await row.getByRole("button", { name: "Save for later" }).focus()
  await page.keyboard.press("Tab")
  await expect(quote).toBeFocused()
  await expect(page.getByRole("tooltip", { name: "Quote reply" })).toBeVisible({ timeout: 3000 })
})
