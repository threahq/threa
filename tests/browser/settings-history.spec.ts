import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspaceViaApi } from "./helpers"

/** The settings window, opened from the sidebar so it sits on the app's own history. */
async function openSettings(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}`)
  await page.locator("[data-settings-entry]").first().click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("navigation", { name: "Settings pages" })).toBeVisible()
  return dialog
}

function openPage(page: Page, name: string) {
  return page
    .getByRole("dialog")
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("link", { name, exact: true })
    .click()
}

const pageHeading = (page: Page, name: string) => page.getByRole("dialog").getByRole("heading", { level: 2, name })

test.describe("Settings history", () => {
  test("every page is an entry Back and Forward walk, and close unwinds them", async ({ page }) => {
    const { workspaceId } = await loginAndCreateWorkspaceViaApi(page, "settings-history")
    await openSettings(page, workspaceId)

    await openPage(page, "Appearance")
    await expect(pageHeading(page, "Appearance")).toBeVisible()
    await openPage(page, "Keyboard & composer")
    await expect(pageHeading(page, "Keyboard & composer")).toBeVisible()

    await page.goBack()
    await expect(pageHeading(page, "Appearance")).toBeVisible()
    await page.goForward()
    await expect(pageHeading(page, "Keyboard & composer")).toBeVisible()

    await page.getByRole("button", { name: "Close settings" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page).not.toHaveURL(/settings=/)
    // The window's entries are behind Forward now, as after pressing Back through them.
    await page.goForward()
    await expect(page).toHaveURL(/settings=/)
  })

  test("a bot's detail is an entry of its own", async ({ page }) => {
    const { workspaceId, testId } = await loginAndCreateWorkspaceViaApi(page, "settings-history-bot")
    const botName = `History Bot ${testId}`
    const created = await page.request.post(`/api/workspaces/${workspaceId}/bots`, {
      data: { name: botName, slug: `history-bot-${testId}` },
    })
    expect(created.ok()).toBe(true)
    const dialog = await openSettings(page, workspaceId)
    await openPage(page, "Shared bots")
    const botLink = dialog.getByRole("link", { name: new RegExp(botName) })

    await botLink.click()
    const back = dialog.getByRole("button", { name: "Back to bots" })
    await expect(back).toBeVisible()
    await page.goBack()
    await expect(botLink).toBeVisible()
    await expect(page).toHaveURL(/settings=bots/)

    await page.goForward()
    await back.click()
    await expect(botLink).toBeVisible()
    // The in-window back popped, so the detail is still ahead.
    await page.goForward()
    await expect(back).toBeVisible()
  })

  test("a page opened from settings goes back to it the way the browser does", async ({ page }) => {
    const { workspaceId } = await loginAndCreateWorkspaceViaApi(page, "settings-history-pages")
    const dialog = await openSettings(page, workspaceId)
    await openPage(page, "Workspace AI")
    await dialog
      .getByRole("link", { name: /^Edit / })
      .first()
      .click()
    await expect(page).toHaveURL(/\/settings\/personas\//)

    await page.getByRole("link", { name: "Back to AI Agents" }).click()
    await expect(pageHeading(page, "Workspace AI")).toBeVisible()
    await page.goForward()
    await expect(page).toHaveURL(/\/settings\/personas\//)

    await page.goBack()
    await dialog.getByRole("link", { name: /Budget and limits/ }).click()
    await expect(page).toHaveURL(/\/admin\/ai-usage/)
    await page.getByRole("link", { name: "Back to workspace" }).click()
    await expect(pageHeading(page, "Workspace AI")).toBeVisible()
    await page.goForward()
    await expect(page).toHaveURL(/\/admin\/ai-usage/)
  })
})
