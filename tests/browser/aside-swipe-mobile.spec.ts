import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

/**
 * The L on a message: swipe left as for a quote, keep the finger down, drag it
 * down, release — an aside opens anchored to that message. Release without the
 * downward leg still quotes. Touch events are dispatched by hand: Playwright
 * has no touch drag, and the gesture lives in touch handlers on the row.
 */

test.describe.configure({ timeout: 150_000 })

const PHONE = { width: 390, height: 780 }

type Point = { x: number; y: number }

async function touchGesture(page: Page, selector: string, path: Point[]): Promise<void> {
  const dispatch = (type: string, point: Point | null) =>
    page.evaluate(
      ({ selector, type, point }) => {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`no element for ${selector}`)
        const touches = point
          ? [
              new Touch({
                identifier: 1,
                target: el,
                clientX: point.x,
                clientY: point.y,
                pageX: point.x,
                pageY: point.y,
              }),
            ]
          : []
        el.dispatchEvent(
          new TouchEvent(type, {
            touches,
            changedTouches: touches,
            targetTouches: touches,
            bubbles: true,
            cancelable: true,
          })
        )
      },
      { selector, type, point }
    )
  const [start, ...moves] = path
  await dispatch("touchstart", start)
  for (const point of moves) {
    await dispatch("touchmove", point)
    await page.waitForTimeout(30)
  }
  await dispatch("touchend", null)
}

test.describe("Aside — the L on a message", () => {
  test.use({ hasTouch: true })

  test("swipe then down opens an aside on the message; swipe alone still quotes", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "aside-swipe")
    const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
    const created = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "channel", name: `swipe-${testId}`, slug: `swipe-${testId}`, visibility: "public" },
    })
    expectApiOk(created, "Create channel")
    const streamId = (await created.json()).stream.id as string
    for (let n = 1; n <= 4; n++) {
      expectApiOk(
        await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
          data: { streamId, content: `[${testId}] msg-${String(n).padStart(3, "0")}` },
        }),
        `Send message ${n}`
      )
    }
    await page.setViewportSize(PHONE)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    const scroller = page.locator(`[data-stream-scroller="${streamId}"]`)
    await expect(scroller).toBeVisible({ timeout: 20000 })

    const row = scroller.locator("[data-message-id]").filter({ hasText: "msg-003" }).first()
    const messageId = await row.getAttribute("data-message-id")
    // The touch handlers sit on the row wrapper's first child, not on the id-stamped node.
    const rowSelector = `[data-stream-scroller="${streamId}"] [data-message-id="${messageId}"] > :first-child`
    const box = (await row.boundingBox())!
    const from = { x: box.x + box.width - 40, y: box.y + box.height / 2 }

    // Swipe alone: the quote reveal lights, and release quotes into the composer.
    await touchGesture(page, rowSelector, [from, { x: from.x - 60, y: from.y }, { x: from.x - 110, y: from.y }])
    await expect(page.locator("[data-message-composer-root]").getByText("msg-003")).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId("aside-sheet")).toHaveCount(0)

    // The quote left the caret in the composer; drop it so the sheet's rest
    // position is the gesture's own (a focused composer would lift it to full).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    // The L: same stroke, then the finger comes down before it lifts.
    await touchGesture(page, rowSelector, [
      from,
      { x: from.x - 60, y: from.y },
      { x: from.x - 110, y: from.y },
      { x: from.x - 110, y: from.y + 40 },
    ])
    const sheet = page.getByTestId("aside-sheet")
    await expect(sheet).toBeVisible({ timeout: 15000 })
    await expect(sheet).toHaveAttribute("data-detent", "peek")
    // Anchored to that message: its anchor row lands beside msg-003.
    const anchor = scroller.locator("[data-aside-id]").first()
    await expect(anchor).toBeVisible({ timeout: 10000 })
    const anchorBox = (await anchor.boundingBox())!
    const rowAfter = (await row.boundingBox())!
    expect(anchorBox.y).toBeGreaterThan(rowAfter.y)
    expect(anchorBox.y - rowAfter.y).toBeLessThan(rowAfter.height + 80)
  })
})
