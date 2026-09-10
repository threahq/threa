import { test, expect } from "@playwright/test"
import { openAccountPicker, pickAccount, setUpSharedWorkspace } from "./account-fixtures"

test.describe.configure({ timeout: 180_000 })

test("should keep an external share with the account that received it", async ({ page }) => {
  const { a, b, workspaceId } = await setUpSharedWorkspace(page)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true)
  const sharedText = `private-shared-text-${Date.now()}`
  await page.evaluate(async (text) => {
    const form = new FormData()
    form.set("text", text)
    const response = await fetch("/share", { method: "POST", body: form })
    if (!response.ok) throw new Error(`Share target returned ${response.status}`)
  }, sharedText)

  await openAccountPicker(page, b.profileName)
  await pickAccount(page, a.user.email)
  await page.goto("/share")
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/share`), { timeout: 30_000 })
  await expect(page.getByText(sharedText, { exact: true })).toHaveCount(0)

  await page.goto(`/w/${workspaceId}`)
  await openAccountPicker(page, a.profileName)
  await pickAccount(page, b.user.email)
  await page.goto("/share")
  await expect(page.getByText(sharedText, { exact: true })).toBeVisible({ timeout: 30_000 })
})
