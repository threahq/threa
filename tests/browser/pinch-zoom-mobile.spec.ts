import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * The app shell sizes itself to the visual viewport, so a pinch-zoomed page is
 * a broken one: every surface is cropped at the edges and pans in both axes,
 * and nothing in the UI zooms it back out. Only a real engine answers whether
 * a pinch scales the page — `touch-action` is applied on the compositor.
 */

test.use({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true })

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
)

async function pinchOut(page: Page, y: number) {
  const cdp = await page.context().newCDPSession(page)
  const fingers = (spread: number) => [
    { x: 195 - spread, y, id: 0 },
    { x: 195 + spread, y, id: 1 },
  ]
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(40) })
  for (let spread = 45; spread <= 120; spread += 5) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(spread) })
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  // The scale lands on the compositor a frame or two after the gesture, so
  // give a zoom the chance to show up before asserting its absence.
  await page.waitForTimeout(500)
}

const pageScale = (page: Page) => page.evaluate(() => window.visualViewport?.scale)

test("a two-finger pinch does not zoom the app", async ({ page }) => {
  await loginAndCreateWorkspace(page, "pinch")
  await expect(page.locator("[data-message-composer-root]").first()).toBeVisible({ timeout: 30_000 })

  await pinchOut(page, 300)

  expect(await pageScale(page)).toBe(1)
})

test("a pinch inside the image gallery still zooms the image, not the page", async ({ page }) => {
  await loginAndCreateWorkspace(page, "pinch-gallery")
  await page.getByRole("button", { name: "+ New Scratchpad" }).click()
  const card = page.locator("[data-message-composer-root] [data-composer-card]").first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()

  await page
    .locator('[data-message-composer-root] input[type="file"][multiple]')
    .setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PIXEL_PNG })
  await page.getByRole("button", { name: "Show all attachments" }).click()
  await page.getByRole("button", { name: "Preview shot.png" }).click()
  const image = page.locator("[data-media-gallery] img:not([aria-hidden])").first()
  await expect(image).toBeVisible({ timeout: 20_000 })

  const imageScale = () => image.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)
  const before = await imageScale()

  await pinchOut(page, 400)

  const after = await imageScale()
  expect({ imageZoomed: after > before * 1.5, pageScale: await pageScale(page) }).toEqual({
    imageZoomed: true,
    pageScale: 1,
  })
})
