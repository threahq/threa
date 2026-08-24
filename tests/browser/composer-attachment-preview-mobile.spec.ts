import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * Preview from the mobile attachment sheet. The sheet is a modal vaul drawer
 * and the lightbox is a Radix dialog opened from inside it, so "the preview
 * covers the sheet, and the sheet is still there when it closes" is a question
 * about two real dismissable layers and their paint order — jsdom answers
 * neither. The whole point of the flow is picking the next file straight after
 * closing the last one, so the second preview is part of the assertion.
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 800 }

// 1x1 PNGs, distinct bytes so the two attachments are separate files.
const png = (fill: number) => ({
  name: `shot-${fill}.png`,
  mimeType: "image/png",
  buffer: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, fill)]),
})

test("a file previews from the attachment sheet, and the sheet is still there behind it", async ({ page }) => {
  await loginAndCreateWorkspace(page, "tray-preview")
  await createChannel(page, `preview-${Date.now().toString(36)}`)

  await page.setViewportSize(PHONE)
  await page.reload()

  const card = page.locator("[data-message-composer-root] [data-composer-card]").first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()

  await page.locator('[data-message-composer-root] input[type="file"][multiple]').setInputFiles([png(1), png(2)])

  await page.getByRole("button", { name: "Show all attachments" }).click()
  const sheet = page.locator("[data-vaul-drawer]")
  await expect(sheet).toBeVisible({ timeout: 20_000 })

  await page.getByRole("button", { name: "Preview shot-1.png" }).click()
  const gallery = page.locator("[data-media-gallery]")
  await expect(gallery).toBeVisible({ timeout: 10_000 })

  // The sheet is still mounted underneath, and the lightbox owns the surface:
  // the point under the middle of the viewport belongs to the gallery.
  await expect(sheet).toBeAttached()
  const coveredByGallery = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    return !!el?.closest("[data-media-gallery]")
  })
  expect(coveredByGallery, "the lightbox paints above the sheet").toBe(true)

  await page.locator("[data-media-gallery] button", { hasText: "Close" }).first().click()
  await expect(gallery).toBeHidden({ timeout: 10_000 })

  // Back on the list with no extra taps: the next file is one tap away.
  await expect(sheet).toBeVisible()
  await page.getByRole("button", { name: "Preview shot-2.png" }).click()
  await expect(gallery).toBeVisible({ timeout: 10_000 })
})
