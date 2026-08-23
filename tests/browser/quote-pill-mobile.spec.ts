import { test, expect, type Page } from "@playwright/test"
import { createChannel, expectApiOk, loginAndCreateWorkspace } from "./helpers"
import {
  HANDLE_CLEARANCE_PX,
  RESERVED_BOTTOM_PX,
} from "../../apps/frontend/src/components/timeline/selection-pill-placement"

/**
 * The mobile quote/share pill: where it lands, and that the reader can move it.
 *
 * Chrome's Touch to Search peek and its own selection toolbar are browser
 * surfaces Playwright cannot render, so what is provable here is our half of
 * the contract: the pill sits below the selection, never inside the band
 * reserved for the peek, and a drag parks it somewhere the next selection
 * honours. The placement arithmetic itself is unit-tested in
 * `selection-pill-placement.test.ts`.
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 844 }

const BODY =
  "The pin backfill drained cleanly across every chunk, so the rollout is done and the numbers in the database agree with what the API reports for each workspace."

function workspaceAndStream(page: Page): { workspaceId: string; streamId: string } {
  const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
  expect(match, "workspace + stream should be resolvable from the URL").toBeTruthy()
  return { workspaceId: match![1], streamId: match![2] }
}

async function longPress(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox()
  expect(box).toBeTruthy()
  const point = { x: box!.x + box!.width / 2, y: box!.y + 12 }
  const touch = { identifier: 1, clientX: point.x, clientY: point.y }
  await page.dispatchEvent(selector, "touchstart", {
    touches: [touch],
    changedTouches: [touch],
    targetTouches: [touch],
  })
  await page.waitForTimeout(700)
  await page.dispatchEvent(selector, "touchend", { touches: [], changedTouches: [], targetTouches: [] })
}

/**
 * The pill renders before it has measured itself, so read its box only once a
 * placement has landed. Reading earlier catches it at its pre-measure origin.
 */
async function pillRect(page: Page): Promise<{ y: number; height: number }> {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="selection-pill"]') as HTMLElement | null
    if (!el || el.className.includes("opacity-0")) return false
    // Its entrance animation scales the box, so the rect it reports mid-flight
    // is not where it will come to rest.
    return el.getAnimations().every((animation) => animation.playState === "finished")
  })
  return await page.evaluate(() => {
    const { y, height } = document.querySelector('[data-testid="selection-pill"]')!.getBoundingClientRect()
    return { y, height }
  })
}

/** Drags the pill by its grip, in steps, so the threshold and the move both fire. */
async function dragGripTo(page: Page, to: { x: number; y: number }): Promise<void> {
  const grip = (await page.getByTestId("selection-pill-grip").boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

/**
 * Opens the full-message view and waits for the sheet to finish growing into
 * its expanded height. Measuring against a scroller still in motion samples a
 * placement that is already stale, and the sheet collapses on Back, so the
 * reopen path needs the same wait as the first open.
 */
async function openExpandedView(page: Page): Promise<void> {
  await page.getByTestId("expanded-quote-open").click()
  await expect(page.getByTestId("expanded-quote-title")).toBeVisible()
  await expect
    .poll(async () => page.evaluate(() => document.querySelector("[data-vaul-drawer]")!.getBoundingClientRect().top))
    .toBeLessThan(60)
}

/** Selects `[start, end)` of the expanded view's body, as a long-press drag does. */
async function selectInExpandedBody(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ({ start, end }) => {
      const content = document.querySelector('[data-testid="expanded-quote-body"]')
      const walker = document.createTreeWalker(content!, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode()!
      const selection = window.getSelection()!
      selection.removeAllRanges()
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      selection.addRange(range)
    },
    { start, end }
  )
}

test("the quote pill lands below the selection, clear of the reserved band, and can be parked", async ({
  page: setupPage,
  browser,
}) => {
  await loginAndCreateWorkspace(setupPage, "quote-pill")
  await createChannel(setupPage, `pill-${Date.now().toString(36)}`)
  const { workspaceId, streamId } = workspaceAndStream(setupPage)
  const response = await setupPage.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: {
      streamId,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: BODY }] }] },
      contentMarkdown: BODY,
    },
  })
  await expectApiOk(response, "Create the message to quote from")

  const context = await browser.newContext({
    storageState: await setupPage.context().storageState(),
    hasTouch: true,
    viewport: PHONE,
  })
  const page = await context.newPage()
  await page.goto(setupPage.url())

  const row = "[data-message-id]"
  await expect(page.locator(row).first()).toBeVisible({ timeout: 30_000 })

  // The row's touch handlers live on the layout container inside the wrapper,
  // and synthetic events only bubble upward.
  await longPress(page, `${row} .message-content`)
  const sheet = page.locator("[data-vaul-drawer]")
  await expect(sheet).toBeVisible({ timeout: 10_000 })

  await openExpandedView(page)

  await selectInExpandedBody(page, 4, 24)

  const pill = page.getByTestId("selection-pill")
  await expect(pill).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId("expanded-quote-title")).toHaveText(/20 characters selected/)

  // Below the selection, and never in the band the Touch to Search peek owns.
  const selectionBottom = await page.evaluate(() => window.getSelection()!.getRangeAt(0).getBoundingClientRect().bottom)
  const placed = await pillRect(page)
  expect(placed.y).toBeGreaterThan(selectionBottom)
  expect(placed.y + placed.height).toBeLessThanOrEqual(PHONE.height - RESERVED_BOTTOM_PX)

  // Drag it somewhere of the reader's choosing. Real pointer events, not
  // dispatched ones: `setPointerCapture` needs a pointer the browser knows.
  await dragGripTo(page, { x: 90, y: placed.y - 220 })

  const parked = await pillRect(page)
  expect(parked.y).toBeLessThan(placed.y - 100)

  // A fresh selection honours the parked spot instead of chasing the text.
  await page.evaluate(() => window.getSelection()!.removeAllRanges())
  await expect(pill).toBeHidden()
  await selectInExpandedBody(page, 30, 44)
  await expect(pill).toBeVisible()
  const afterReselect = await pillRect(page)
  expect(Math.abs(afterReselect.y - parked.y)).toBeLessThan(4)

  // Dropped back where it would have gone on its own, it re-attaches: the pill
  // returns to the computed spot, not to wherever the finger happened to land.
  const home = await page.evaluate(() => window.getSelection()!.getRangeAt(0).getBoundingClientRect().bottom)
  await dragGripTo(page, { x: 195, y: home + HANDLE_CLEARANCE_PX + 20 })
  const reattached = await pillRect(page)
  expect(Math.abs(reattached.y - (home + HANDLE_CLEARANCE_PX))).toBeLessThan(2)

  // Closing the view forgets the park: opening it again is a fresh read, and
  // the pill starts back at the selection rather than wherever it was left.
  await dragGripTo(page, { x: 90, y: 200 })
  expect((await pillRect(page)).y).toBeLessThan(home)
  await page.getByRole("button", { name: /back to actions/i }).click()
  await openExpandedView(page)
  await selectInExpandedBody(page, 4, 24)
  const reopened = await pillRect(page)
  expect(Math.abs(reopened.y - placed.y)).toBeLessThan(4)

  await context.close()
})
