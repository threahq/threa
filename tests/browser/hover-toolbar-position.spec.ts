import { test, expect, type Locator, type Page } from "@playwright/test"
import {
  clickReplyInThread,
  createChannel,
  getActivePanel,
  loginAndCreateWorkspace,
  sendPanelReply,
  waitForRealThreadPanel,
} from "./helpers"

/**
 * The desktop hover toolbar floats above the row's content, over the previous
 * row's tail, so the text it belongs to stays readable and selectable — a
 * grouped continuation has only 2px of top padding, and a toolbar overlapping
 * into the row would cover its last line.
 *
 * Continuations are proved inside a thread: the test stub extractor gives every
 * channel message its own conversation, and a conversation change splits the
 * author run, so channel rows never group under test.
 */

test.setTimeout(120_000)

async function box(locator: Locator) {
  const rect = await locator.boundingBox()
  expect(rect).not.toBeNull()
  return rect!
}

async function hoverRow(page: Page, row: Locator) {
  const rowBox = await box(row)
  await page.mouse.move(rowBox.x + 40, rowBox.y + rowBox.height - 4, { steps: 4 })
  const toolbar = row.locator(".reveal-actions-hover-only")
  await expect(toolbar).toHaveCSS("opacity", "1")
  return toolbar
}

async function expectToolbarClearOfContent(row: Locator, toolbar: Locator) {
  const toolbarBox = await box(toolbar)
  const contentBox = await box(row.locator(".message-content"))
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(contentBox.y + 1)
}

test("the hover toolbar sits above the text of heads and grouped continuations and survives a diagonal reach", async ({
  page,
}) => {
  const { testId } = await loginAndCreateWorkspace(page, "hover-toolbar")
  await createChannel(page, `hover-toolbar-${testId}`)
  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  const headText = `head ${testId}`
  await page.keyboard.type(headText)
  await page.keyboard.press("Enter")

  const head = page.getByRole("main").first().locator(".message-item").filter({ hasText: headText }).first()
  await expect(head.getByRole("link", { name: "Reply in thread" })).toBeAttached({ timeout: 10_000 })
  const headToolbar = await hoverRow(page, head)
  await expectToolbarClearOfContent(head, headToolbar)
  // The first row of a stream scrolled to its top keeps its toolbar inside the
  // scroller's padding rather than clipped by its edge.
  const clippedBy = await headToolbar.evaluate((el) => {
    let scroller = el.parentElement
    while (scroller && getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement
    return scroller ? scroller.getBoundingClientRect().top - el.getBoundingClientRect().top : 0
  })
  expect(clippedBy).toBeLessThanOrEqual(0)

  await clickReplyInThread(head)
  await sendPanelReply(page, `first reply ${testId}`)
  await waitForRealThreadPanel(page)
  const continuationText = `continuation ${testId} ${"that wraps onto a second line ".repeat(6)}`
  await sendPanelReply(page, continuationText)

  const continuation = getActivePanel(page)
    .locator(".message-item")
    .filter({ hasText: `continuation ${testId}` })
    .first()
  await expect(continuation.getByRole("link", { name: "Reply in thread" })).toBeAttached({ timeout: 10_000 })
  await expect(continuation.locator("xpath=..")).toHaveAttribute("data-group-continuation", "true")
  const continuationToolbar = await hoverRow(page, continuation)
  await expectToolbarClearOfContent(continuation, continuationToolbar)
  await expect(continuation.locator("xpath=..")).toHaveAttribute("data-group-continuation", "true")

  // A diagonal reach from the text up to the chip passes over the previous row
  // just left of the chip; that stretch must stay inside this row's hover
  // subtree, or the previous row takes the hover and the toolbar fades out.
  const chip = await box(continuationToolbar.locator("> div"))
  const rowTop = (await box(continuation)).y
  await page.mouse.move(chip.x - 40, rowTop + 10, { steps: 4 })
  await page.mouse.move(chip.x - 16, chip.y + chip.height / 2, { steps: 4 })
  expect(await continuationToolbar.evaluate((el) => el.matches(":hover"))).toBe(true)
  await expect(continuationToolbar).toHaveCSS("opacity", "1")
})
