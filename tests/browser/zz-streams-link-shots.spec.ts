import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

test.describe.configure({ timeout: 180_000 })

const OUT = process.env.SHOTS_DIR ?? "/tmp/sidebar-shots"

test("streams quick link screenshots", async ({ page, browser }) => {
  await loginAndCreateWorkspace(page, "streams-link")
  const ws = page.url().match(/\/w\/([^/?]+)/)![1]
  const storageState = await page.context().storageState()
  const desk = await browser.newContext({ storageState, viewport: { width: 1280, height: 860 } })
  const dp = await desk.newPage()
  await dp.goto(`/w/${ws}/streams`)
  await expect(dp.getByRole("link", { name: "Drafts" }).first()).toBeVisible({ timeout: 30_000 })
  await dp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 5000 }).catch(() => {})
  await dp.waitForTimeout(1500)
  await dp.screenshot({ path: `${OUT}/streams-page.png` })
  await dp.goto(`/w/${ws}/drafts`)
  await dp.waitForTimeout(1500)
  await dp.screenshot({ path: `${OUT}/drafts-page.png` })
})
