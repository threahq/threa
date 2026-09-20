import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * The search page's query input at phone width. A query is one line: Enter must
 * not start a second paragraph, and a long unbroken word scrolls inside the
 * input instead of widening the page. Both are layout, which jsdom cannot answer.
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 800 }

test("the query stays one line inside its box and never widens the page", async ({ page }) => {
  await loginAndCreateWorkspace(page, "search-input")
  const workspaceId = page.url().match(/\/w\/([^/]+)/)?.[1]
  expect(workspaceId, `workspace id in URL: ${page.url()}`).toBeTruthy()

  await page.setViewportSize(PHONE)
  await page.goto(`/w/${workspaceId}/search`)

  const input = page.getByLabel("Search messages", { exact: true })
  await expect(input).toBeVisible({ timeout: 30_000 })
  await input.click()
  await page.keyboard.type("first line")
  await page.keyboard.press("Enter")
  await page.keyboard.type(` ${"unbreakable".repeat(12)}`)

  await expect(input.locator("p")).toHaveCount(1)

  const geometry = await page.evaluate(() => {
    const editor = document.querySelector('[aria-label="Search messages"]')!
    const headerRow = editor.closest("header")!.firstElementChild!
    const box = editor.getBoundingClientRect()
    const row = headerRow.getBoundingClientRect()
    return {
      pageScrolls: document.documentElement.scrollWidth > window.innerWidth,
      pannedAncestor: (() => {
        for (let el = editor.parentElement; el; el = el.parentElement) if (el.scrollLeft > 0) return true
        return false
      })(),
      insideViewport: box.left >= 0 && box.right <= window.innerWidth,
      insideHeaderRow: box.top >= row.top && box.bottom <= row.bottom,
    }
  })
  expect(geometry).toEqual({
    pageScrolls: false,
    pannedAncestor: false,
    insideViewport: true,
    insideHeaderRow: true,
  })
})
