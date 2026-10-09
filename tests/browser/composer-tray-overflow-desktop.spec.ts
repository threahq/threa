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

// Enough chips to fill the tray's capped chip row on any desktop width, so the
// squeeze does not depend on how many chips fit on one row.
const FILE_COUNT = 16

test("a tall attachment tray keeps the editor's text and toolbars inside the card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const { testId } = await loginAndCreateWorkspace(page, "tray-overflow")
  await createChannel(page, `tray-${testId}`)

  const root = page.locator("[data-message-composer-root]").first()
  const card = root.locator("[data-composer-card]")
  await expect(card).toBeVisible({ timeout: 30_000 })
  const editor = root.locator(".tiptap")
  const slot = root.getByTestId("composer-editor-scroll")
  await editor.click()
  const typeLongDraft = async (tail: string) => {
    for (let i = 0; i < 10; i++) {
      await page.keyboard.type(`${i} ${LINE}`)
      await page.keyboard.press("Shift+Enter")
    }
    await page.keyboard.type(tail)
  }
  await typeLongDraft("Let's")

  await root.locator('input[type="file"][multiple]').setInputFiles(
    Array.from({ length: FILE_COUNT }, (_, i) => ({
      name: `pasted-image-${i + 1}.png`,
      mimeType: "image/png",
      buffer: Buffer.alloc(1024, i),
    }))
  )
  await expect(root.getByTestId("attachment-chip-row")).toBeVisible({ timeout: 20_000 })
  await expect(root.getByText(`${FILE_COUNT} files`)).toBeVisible()
  // Precondition for everything below: the tray must have squeezed the slot
  // under the editor's own 200px scroll cap, or nothing here can fail.
  const slotHeight = async () => (await slot.boundingBox())!.height
  await expect.poll(slotHeight).toBeLessThan(200)
  // Keep writing: the editor brings the caret line back into view through
  // whichever box scrolls, so the caret line must land inside the editor's
  // slot, above the action bar, not below the card.
  await page.keyboard.type(" go")

  // Pixels by which the caret line escapes the slot or the action bar; 0 = contained.
  const lastLineOverflow = () =>
    page.evaluate(() => {
      const edges = (b: DOMRect) => ({ top: Math.round(b.top), bottom: Math.round(b.bottom) })
      const root = document.querySelector("[data-message-composer-root]")!
      const slot = edges(root.querySelector('[data-testid="composer-editor-scroll"]')!.getBoundingClientRect())
      // The caret line is the last text line box, not the paragraph block:
      // the editor scrolls the caret into view, and a paragraph's line-height
      // slack hangs a pixel or two past that.
      const paragraphs = root.querySelectorAll(".tiptap > p")
      const range = document.createRange()
      range.selectNodeContents(paragraphs[paragraphs.length - 1])
      const lines = range.getClientRects()
      const lastLine = edges(lines[lines.length - 1])
      const sendTop = edges(root.querySelector('button[aria-label="Send"]')!.getBoundingClientRect()).top
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
  await typeLongDraft("Let's go")
  await root.getByRole("button", { name: "Formatting" }).click()
  await page.keyboard.press("Control+End")
  await page.keyboard.type(" on")
  await expect.poll(slotHeight).toBeLessThan(200)
  await expect.poll(lastLineOverflow).toBe(0)
  // Pixels by which the bar leaves the slot's top or overlaps the text; 0 = above the text.
  const barOverlap = () =>
    page.evaluate(() => {
      const rect = (sel: string) =>
        document.querySelector("[data-message-composer-root]")!.querySelector(sel)!.getBoundingClientRect()
      const bar = rect('button[aria-label="Bold"]')
      const slot = rect('[data-testid="composer-editor-scroll"]')
      const text = rect(".tiptap")
      return Math.max(0, Math.ceil(slot.top - bar.top), Math.ceil(bar.bottom - text.top))
    })
  await expect.poll(barOverlap).toBe(0)
})
