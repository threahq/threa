import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 800 }

test("mobile composer resizes from its top edge without losing the editor bottom", async ({ page }) => {
  await loginAndCreateWorkspace(page, "composer-resize")
  await createChannel(page, `resize-${Date.now().toString(36)}`)
  await page.setViewportSize(PHONE)
  await page.reload()

  const card = page.locator("[data-message-composer-root] [data-composer-card]").first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()

  const editor = page.locator("[data-message-composer-root] .tiptap").first()
  const scroller = page.getByTestId("composer-editor-scroll")
  const handle = page.getByTestId("composer-resize-handle")
  await expect(handle).toBeVisible({ timeout: 10_000 })

  await editor.click()
  for (let i = 1; i <= 24; i++) {
    await editor.pressSequentially(`line ${i}`)
    await page.keyboard.press("Shift+Enter")
  }

  await scroller.evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 24)
  })

  const measure = () =>
    page.evaluate(() => {
      const cardEl = document.querySelector("[data-message-composer-root] [data-composer-card]") as HTMLElement
      const handleEl = document.querySelector('[data-testid="composer-resize-handle"]') as HTMLElement
      const scrollerEl = document.querySelector('[data-testid="composer-editor-scroll"]') as HTMLElement
      const cardRect = cardEl.getBoundingClientRect()
      const handleRect = handleEl.getBoundingClientRect()
      const scrollerRect = scrollerEl.getBoundingClientRect()
      return {
        cardTop: Math.round(cardRect.top),
        cardBottom: Math.round(cardRect.bottom),
        cardHeight: Math.round(cardRect.height),
        handleWidth: Math.round(handleRect.width),
        editorInset: Math.round(scrollerRect.top - cardRect.top),
        scrollBottom: Math.round(scrollerEl.scrollHeight - scrollerEl.clientHeight - scrollerEl.scrollTop),
      }
    })

  const before = await measure()
  expect(before.handleWidth).toBeLessThanOrEqual(64)
  expect(before.editorInset).toBeLessThanOrEqual(16)

  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120)
  await page.mouse.up()

  const after = await measure()
  expect(after.cardHeight).toBeLessThan(before.cardHeight)
  expect(after.cardTop).toBeGreaterThan(before.cardTop)
  expect(after.cardBottom).toBeCloseTo(before.cardBottom, 0)
  expect(after.scrollBottom).toBeLessThanOrEqual(before.scrollBottom + 1)
})
