import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * The app shell sizes itself to the visual viewport, so a pinch-zoomed page is
 * a broken one: every surface is cropped at the edges and pans in both axes,
 * and nothing in the UI zooms it back out. Only a real engine answers whether
 * a pinch scales the page — `touch-action` is applied on the compositor.
 */

test.use({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true })

test("a two-finger pinch does not zoom the app", async ({ page }) => {
  await loginAndCreateWorkspace(page, "pinch")
  await expect(page.locator("[data-message-composer-root]").first()).toBeVisible({ timeout: 30_000 })

  const cdp = await page.context().newCDPSession(page)
  const fingers = (spread: number) => [
    { x: 195 - spread, y: 300, id: 0 },
    { x: 195 + spread, y: 300, id: 1 },
  ]
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(40) })
  for (let spread = 45; spread <= 120; spread += 5) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(spread) })
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })

  // The scale lands on the compositor a frame or two after the gesture, so
  // give a zoom the chance to show up before asserting its absence.
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
})
