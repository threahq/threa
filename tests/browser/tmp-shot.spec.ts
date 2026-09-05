import { test } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

test.describe.configure({ timeout: 120_000 })

test("shots", async ({ page }) => {
  await loginAndCreateWorkspace(page, "shot")
  await createChannel(page, `shot-${Date.now().toString(36)}`)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.reload()
  const card = page.locator("[data-message-composer-root] [data-composer-card]").first()
  await card.waitFor({ state: "visible", timeout: 30_000 })
  await card.click()
  const png = (n: number) => ({
    name: `photo-${n}.png`,
    mimeType: "image/png",
    buffer: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, n)]),
  })
  await page
    .locator('[data-message-composer-root] input[type="file"][multiple]')
    .setInputFiles([png(1), png(2), { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello notes") }])
  await page.getByRole("button", { name: "Show all attachments" }).click()
  await page.locator("[data-vaul-drawer]").waitFor({ state: "visible", timeout: 20_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: "/tmp/shot-sheet.png" })
  await page.getByRole("button", { name: "Preview notes.txt" }).click()
  await page.locator("[data-media-gallery]").waitFor({ state: "visible", timeout: 10_000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: "/tmp/shot-preview.png" })
})
