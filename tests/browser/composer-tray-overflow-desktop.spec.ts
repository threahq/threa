import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * The inline composer's root is height-capped and the attachment tray sits
 * inside that cap, so a tall tray shrinks the editor card. The editor must then
 * scroll inside the room it is left with, while its toolbars stay outside the
 * scroller: a selection bubble above a short selection must stay hittable, and
 * the formatting bar must not scroll away with the text. Only a real engine
 * answers this: the heights come from flex distribution over measured boxes.
 */

test.describe.configure({ timeout: 120_000 })

const LINE =
  "The overall theme is lack of polish and inconsistency, but there are also some major design work that needs doing."

test("a tall attachment tray never pushes the editor's text out of the card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const { testId } = await loginAndCreateWorkspace(page, "tray-overflow")
  await createChannel(page, `tray-${testId}`)

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

  // Pixels by which the caret line escapes the slot or the action bar; 0 = contained.
  const lastLineOverflow = () =>
    page.evaluate(() => {
      const box = (el: Element) => {
        const b = el.getBoundingClientRect()
        return { top: Math.round(b.top), bottom: Math.round(b.bottom) }
      }
      const root = document.querySelector("[data-message-composer-root]")!
      const slot = box(root.querySelector('[data-testid="composer-editor-scroll"]')!)
      // The caret line is the last text line box, not the paragraph block:
      // the editor scrolls the caret into view, and a paragraph's line-height
      // slack hangs a pixel or two past that.
      const paragraphs = root.querySelectorAll(".tiptap > p")
      const range = document.createRange()
      range.selectNodeContents(paragraphs[paragraphs.length - 1])
      const lines = range.getClientRects()
      const lastLine = box({ getBoundingClientRect: () => lines[lines.length - 1] } as Element)
      const sendTop = box(root.querySelector('button[aria-label="Send"]')!).top
      return Math.max(0, slot.top - lastLine.top, lastLine.bottom - slot.bottom, lastLine.bottom - sendTop)
    })
  await expect.poll(lastLineOverflow).toBe(0)

  // The selection bubble sits above the selection, outside the editor box. Any
  // scroller between it and the page would clip it, so it must be what the
  // pointer lands on, including over a one-line draft whose box is shorter
  // than the bubble.
  const bold = root.getByRole("button", { name: "Bold" })
  const boldUnderPointer = () =>
    bold.evaluate((el) => {
      const b = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))
    })
  await page.keyboard.press("Shift+Home")
  await expect(bold).toBeVisible()
  await expect.poll(boldUnderPointer).toBe(true)
  await page.keyboard.press("Control+A")
  await page.keyboard.type("Short draft")
  await page.keyboard.press("Shift+Home")
  await expect(bold).toBeVisible()
  await expect.poll(boldUnderPointer).toBe(true)

  // The formatting bar opens above the text and stays there while the text scrolls.
  await page.keyboard.press("Control+A")
  for (let i = 0; i < 10; i++) {
    await page.keyboard.type(`${i} ${LINE}`)
    await page.keyboard.press("Shift+Enter")
  }
  await page.keyboard.type("Let's go")
  await root.getByRole("button", { name: "Formatting" }).click()
  await editor.click({ position: { x: 5, y: 5 } })
  await page.keyboard.press("Control+End")
  await page.keyboard.type(" on")
  await expect.poll(lastLineOverflow).toBe(0)
  const barAboveText = () =>
    page.evaluate(() => {
      const rect = (sel: string) =>
        document.querySelector("[data-message-composer-root]")!.querySelector(sel)!.getBoundingClientRect()
      const bar = rect('button[aria-label="Bold"]')
      const slot = rect('[data-testid="composer-editor-scroll"]')
      const text = rect(".tiptap")
      return bar.top >= slot.top && bar.bottom <= text.top
    })
  await expect.poll(barAboveText).toBe(true)
})
