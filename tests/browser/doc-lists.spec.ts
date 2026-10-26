import { test, expect, type Page } from "@playwright/test"
import {
  anchorRow,
  createChannelViaApi,
  createDocViaApi,
  docEditor,
  loginAndCreateWorkspace,
  openChannel,
  pane,
  renameDoc,
  workspaceIdFromUrl,
} from "./helpers"

/**
 * `/docs` lists every doc the viewer can read across their streams, filtered from the URL, and the quick
 * switcher finds a doc by its title and names the stream it lives in.
 */

test.describe.configure({ timeout: 120_000 })

const docRow = (page: Page, title: string) => page.getByRole("listitem").getByRole("link", { name: new RegExp(title) })

async function setUp(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "doc-lists")
  const workspaceId = workspaceIdFromUrl(page)
  const alphaSlug = `alpha-${testId}`
  const betaSlug = `beta-${testId}`
  const alphaId = await createChannelViaApi(page, workspaceId, alphaSlug)
  const betaId = await createChannelViaApi(page, workspaceId, betaSlug)
  const alphaDoc = await createDocViaApi(page, workspaceId, alphaId)
  const betaDoc = await createDocViaApi(page, workspaceId, betaId)
  const alphaTitle = `Roadmap ${testId}`
  const betaTitle = `Retro ${testId}`
  await renameDoc(page, workspaceId, alphaDoc, alphaTitle)
  await renameDoc(page, workspaceId, betaDoc, betaTitle)

  await openChannel(page, workspaceId, alphaId)
  await anchorRow(page, alphaDoc).click()
  const editor = docEditor(page, alphaDoc)
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
  await editor.click()
  await page.keyboard.type("First quarter goals")
  await expect(editor).toContainText("First quarter goals")

  return { workspaceId, alphaSlug, alphaDoc, alphaTitle, betaTitle }
}

async function openSwitcher(page: Page, query: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.type(query)
}

test.describe("Doc lists", () => {
  test("should list, filter and open docs when browsing from the quick switcher", async ({ page }) => {
    const { workspaceId, alphaSlug, alphaDoc, alphaTitle, betaTitle } = await setUp(page)

    await openSwitcher(page, "> Browse docs")
    await page.getByRole("option", { name: /Browse docs/ }).click()
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/docs`))
    await expect(docRow(page, alphaTitle)).toBeVisible({ timeout: 15000 })
    await expect(docRow(page, betaTitle)).toBeVisible()
    await expect(docRow(page, alphaTitle)).toContainText(`in #${alphaSlug}`)

    const search = page.getByRole("searchbox", { name: "Search docs" })
    await search.fill("Retro")
    await expect(page).toHaveURL(/[?&]q=Retro/)
    await expect(docRow(page, betaTitle)).toBeVisible()
    await expect(docRow(page, alphaTitle)).toHaveCount(0)
    await search.fill("")
    await expect(page).not.toHaveURL(/[?&]q=/)
    await expect(docRow(page, alphaTitle)).toBeVisible()

    await page.getByRole("button", { name: "Filter by host" }).click()
    const hostOption = page.getByRole("menuitem", { name: `#${alphaSlug}` })
    await expect(hostOption).toBeVisible()
    await hostOption.click()
    await expect(page).toHaveURL(/[?&]host=/)
    await expect(page.getByRole("button", { name: `Host: #${alphaSlug}` })).toBeVisible()
    await expect(docRow(page, alphaTitle)).toBeVisible()
    await expect(docRow(page, betaTitle)).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole("button", { name: `Host: #${alphaSlug}` })).toBeVisible({ timeout: 15000 })
    await expect(docRow(page, alphaTitle)).toBeVisible()
    await expect(docRow(page, betaTitle)).toHaveCount(0)

    await docRow(page, alphaTitle).click()
    await expect(pane(page, alphaDoc).getByRole("textbox", { name: "Doc title" })).toHaveValue(alphaTitle, {
      timeout: 15000,
    })
  })

  test("should find a doc by title and name its channel when searching the quick switcher", async ({ page }) => {
    const { alphaSlug, alphaTitle } = await setUp(page)

    await openSwitcher(page, alphaTitle)
    const option = page.getByRole("option", { name: new RegExp(alphaTitle) })
    await expect(option).toBeVisible()
    await expect(option).toContainText(`Doc · in #${alphaSlug}`)
  })
})
