import { expect, test } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

test.describe("dynamic naming", () => {
  test("an unnamed scratchpad receives its bounded stub title after checkpoint 3", async ({ page }) => {
    await loginAndCreateWorkspace(page, "dynamic-naming")
    await page.getByRole("button", { name: "+ New Scratchpad" }).click()
    await expect(page.getByText(/Type a message|No messages yet/)).toBeVisible({ timeout: 5_000 })

    for (const content of ["Planning the lunar garden", "Choose soil for moon tomatoes", "Set the watering schedule"]) {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type(content)
      await page.getByRole("button", { name: "Send" }).click()
      await expect(page.getByRole("main").getByText(content)).toBeVisible({ timeout: 5_000 })
    }

    await expect(page.getByText("Untitled conversation", { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  })
})
