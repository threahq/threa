import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * The sidebar's History control: a per-user journal of visited streams that
 * drives Back / Forward (menu rows and Ctrl+[ / Ctrl+]) and a "recent" list.
 * Journal state lives in localStorage, so it must survive a reload.
 */

test.describe.configure({ timeout: 240_000 })

const PHONE = { width: 390, height: 780 }

function streamIdFromUrl(page: Page): string {
  const match = page.url().match(/\/s\/([^/?]+)/)
  if (!match) throw new Error(`No stream id in URL: ${page.url()}`)
  return match[1]
}

async function visitChannel(page: Page, channelName: string): Promise<string> {
  await page.getByRole("link", { name: `#${channelName}` }).click()
  await expect(page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({ timeout: 10_000 })
  return streamIdFromUrl(page)
}

async function openHistory(page: Page) {
  await page.getByRole("button", { name: "History", exact: true }).click()
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible({ timeout: 5_000 })
  return menu
}

/** Three channels visited in order; returns their ids keyed by name. */
async function setUpThreeVisits(page: Page, testId: string) {
  const names = { alpha: `alpha-${testId}`, bravo: `bravo-${testId}`, charlie: `charlie-${testId}` }
  await createChannel(page, names.alpha)
  await createChannel(page, names.bravo)
  await createChannel(page, names.charlie)
  const alpha = await visitChannel(page, names.alpha)
  const bravo = await visitChannel(page, names.bravo)
  const charlie = await visitChannel(page, names.charlie)
  return { names, ids: { alpha, bravo, charlie } }
}

/**
 * Open the phone sidebar when it is closed; a no-op once it is showing.
 * Two toggles carry "Pin sidebar" (sidebar header and page header); the one
 * belonging to the off-screen sidebar cannot be clicked, so pick the on-screen one.
 */
async function ensureSidebarOpen(page: Page): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
  const collapse = nav.getByRole("button", { name: "Collapse sidebar" })
  if (await collapse.isVisible().catch(() => false)) return

  const toggles = page.getByRole("button", { name: "Pin sidebar" })
  const viewport = page.viewportSize()
  const count = await toggles.count()
  for (let i = 0; i < count; i += 1) {
    const box = await toggles.nth(i).boundingBox()
    if (!box || !viewport) continue
    if (box.x >= 0 && box.x + box.width <= viewport.width) {
      await toggles.nth(i).click()
      break
    }
  }
  await expect(collapse).toBeVisible({ timeout: 15_000 })
}

test.describe("Navigation history", () => {
  test("desktop: recent list, Back/Forward rows, shortcuts, and persistence across reload", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "nav-history")
    const { names, ids } = await setUpThreeVisits(page, testId)
    const bravoUrl = new RegExp(`/s/${ids.bravo}(\\?|$)`)
    const charlieUrl = new RegExp(`/s/${ids.charlie}(\\?|$)`)

    // Header row first, then recent: newest first, the current stream (charlie) excluded.
    let menu = await openHistory(page)
    await expect(menu.getByRole("menuitem")).toContainText(["Back", "Forward", names.bravo, names.alpha])

    await menu.getByRole("menuitem", { name: "Back" }).click()
    await expect(page).toHaveURL(bravoUrl, { timeout: 10_000 })
    await expect(page.getByRole("menu")).toHaveCount(0)

    menu = await openHistory(page)
    await menu.getByRole("menuitem", { name: "Forward" }).click()
    await expect(page).toHaveURL(charlieUrl, { timeout: 10_000 })
    await expect(page.getByRole("menu")).toHaveCount(0)

    // Keyboard: Ctrl+[ back, Ctrl+] forward.
    await page.keyboard.press("Control+[")
    await expect(page).toHaveURL(bravoUrl, { timeout: 10_000 })
    await page.keyboard.press("Control+]")
    await expect(page).toHaveURL(charlieUrl, { timeout: 10_000 })

    // The journal is in localStorage: a reload keeps both the list and the cursor.
    await page.reload()
    await expect(page.getByRole("heading", { name: `#${names.charlie}`, level: 1 })).toBeVisible({ timeout: 20_000 })
    menu = await openHistory(page)
    await expect(menu.getByRole("menuitem")).toContainText(["Back", "Forward", names.bravo, names.alpha])
    await menu.getByRole("menuitem", { name: "Back" }).click()
    await expect(page).toHaveURL(bravoUrl, { timeout: 10_000 })
  })

  test.describe("phone", () => {
    test("Back from the sidebar sheet navigates and closes the sheet", async ({ page }) => {
      // Setup drives desktop chrome (the sidebar's "+ New Channel"), so the
      // phone viewport is taken only once the fixture streams exist. The narrow
      // viewport alone puts the sidebar into its sheet mode; a coarse pointer
      // would do the same at desktop width and park "+ New Channel" off-screen.
      const { testId } = await loginAndCreateWorkspace(page, "nav-history-phone")
      const { ids } = await setUpThreeVisits(page, testId)
      await page.setViewportSize(PHONE)

      await ensureSidebarOpen(page)
      const menu = await openHistory(page)
      await menu.getByRole("menuitem", { name: "Back" }).click()

      await expect(page).toHaveURL(new RegExp(`/s/${ids.bravo}(\\?|$)`), { timeout: 10_000 })
      await expect(page.getByRole("menu")).toHaveCount(0)
      const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
      await expect(nav.getByRole("button", { name: "Collapse sidebar" })).toHaveCount(0)
    })
  })
})
