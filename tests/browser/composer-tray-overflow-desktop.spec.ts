import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * The inline composer's root is height-capped and the attachment tray sits
 * inside that cap, so a tall tray shrinks the editor card. The editor must then
 * scroll inside the slot it is left with. When the editor element held its own
 * 200px scroll cap instead, it kept that height in a shorter slot and painted
 * through the action bar and out of the card. Only a real engine answers this:
 * the slot's height comes from flex distribution over measured boxes.
 */

test.describe.configure({ timeout: 120_000 })

const LINE =
  "The overall theme is lack of polish and inconsistency, but there are also some major design work that needs doing."

test("a tall attachment tray never pushes the editor's text out of the card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await loginAndCreateWorkspace(page, "tray-overflow")
  await createChannel(page, `tray-${Date.now().toString(36)}`)

  const root = page.locator("[data-message-composer-root]").first()
  const card = root.locator("[data-composer-card]")
  await expect(card).toBeVisible({ timeout: 30_000 })
  const editor = root.locator(".tiptap")
  await editor.click()
  for (let i = 0; i < 10; i++) {
    await page.keyboard.type(`${i} ${LINE}`)
    await page.keyboard.press("Shift+Enter")
  }
  await page.keyboard.type("Let's")

  await root.locator('input[type="file"][multiple]').setInputFiles(
    Array.from({ length: 7 }, (_, i) => ({
      name: `pasted-image-${i + 1}.png`,
      mimeType: "image/png",
      buffer: Buffer.alloc(1024, i),
    }))
  )
  await expect(page.getByTestId("attachment-chip-row")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText("7 files")).toBeVisible()
  // Keep writing: the editor brings the caret line back into view through
  // whichever box scrolls, so the caret line must land inside the editor's
  // slot, above the action bar, not below the card.
  await page.keyboard.type(" go")

  const measure = () =>
    page.evaluate(() => {
      const root = document.querySelector("[data-message-composer-root]")!
      const box = (el: Element) => {
        const b = el.getBoundingClientRect()
        return { top: Math.round(b.top), bottom: Math.round(b.bottom) }
      }
      const slot = box(root.querySelector('[data-testid="composer-editor-scroll"]')!)
      const paragraphs = root.querySelectorAll(".tiptap > p")
      const lastLine = box(paragraphs[paragraphs.length - 1])
      return { slot, lastLine, sendTop: box(root.querySelector('button[aria-label="Send"]')!).top }
    })
  await expect
    .poll(async () => {
      const { slot, lastLine, sendTop } = await measure()
      return lastLine.top >= slot.top && lastLine.bottom <= slot.bottom && lastLine.bottom <= sendTop
    })
    .toBe(true)
})
