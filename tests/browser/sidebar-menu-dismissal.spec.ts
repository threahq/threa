import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * Sidebar menus render in a portal and outlive the sidebar's DOM, and Radix
 * dismisses a touch pointerdown only on the click that follows it — a swipe
 * never clicks. Closing the sidebar must close its open menus too.
 */

test.describe.configure({ timeout: 180_000 })

const PHONE = { width: 390, height: 780 }

async function openHistory(page: Page) {
  await page.getByRole("button", { name: "History", exact: true }).click()
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible({ timeout: 5_000 })
  return menu
}

/** Two toggles carry "Pin sidebar"; the sidebar's own sits off-screen while closed, so click the one in view. */
async function openPhoneSidebar(page: Page) {
  const toggles = page.getByRole("button", { name: "Pin sidebar" })
  await expect(toggles.first()).toBeAttached({ timeout: 20_000 })
  const count = await toggles.count()
  for (let i = 0; i < count; i += 1) {
    const box = await toggles.nth(i).boundingBox()
    if (box && box.x >= 0 && box.x + box.width <= PHONE.width) {
      await toggles.nth(i).click()
      return
    }
  }
  throw new Error("No on-screen sidebar toggle")
}

test("desktop: the toggle shortcut closes the sidebar and its open menu together", async ({ page }) => {
  const { testId } = await loginAndCreateWorkspace(page, "menu-dismiss")
  await createChannel(page, `menu-${testId}`)
  const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
  await expect(nav.getByRole("button", { name: "Collapse sidebar" })).toBeVisible()

  const menu = await openHistory(page)
  // Playwright has no "§" key; the shortcut leaves the focused menu item like a real press.
  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "§", ctrlKey: true, bubbles: true }))
  })

  await expect(menu).toHaveCount(0)
  // The mouse still rests on the sidebar, so the unpinned sidebar lingers as a hover preview.
  await expect(nav.getByRole("button", { name: "Collapse sidebar" })).toHaveCount(0)
  await page.mouse.move(900, 400)
  await expect(nav).toHaveCSS("width", "0px", { timeout: 3_000 })
})

test("phone: a closing swipe dismisses the open menu before the sheet leaves", async ({ page: setupPage, browser }) => {
  const { testId } = await loginAndCreateWorkspace(setupPage, "menu-dismiss-phone")
  await createChannel(setupPage, `menu-${testId}`)
  const storageState = await setupPage.context().storageState()
  const context = await browser.newContext({ storageState, hasTouch: true, viewport: PHONE })
  const page = await context.newPage()
  await page.goto(setupPage.url())

  const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
  const collapse = nav.getByRole("button", { name: "Collapse sidebar" })
  await openPhoneSidebar(page)
  await expect(collapse).toBeVisible({ timeout: 15_000 })

  // Dismissing a menu by itself keeps the sheet open.
  await openHistory(page)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toHaveCount(0)
  await page.waitForTimeout(400)
  await expect(collapse).toBeVisible()

  const menu = await openHistory(page)
  const cdp = await page.context().newCDPSession(page)
  const y = 400
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 340, y, id: 1 }] })
  for (const x of [320, 280, 220, 160, 100]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 1 }] })
  }
  await expect(menu).toHaveCount(0)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })

  await expect(collapse).toHaveCount(0, { timeout: 5_000 })
  await context.close()
})
