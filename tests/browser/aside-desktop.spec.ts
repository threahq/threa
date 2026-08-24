import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The desktop aside surface end to end: open from a message beside the host
 * (never scrolling it — INV-70 has one lander and the aside is not a second),
 * talk to the companion in the aside grounded in the viewport snapshot, fold
 * away on navigation (no chrome anywhere else), and resume from the anchor row
 * silently (no toast, no badge — INV-63).
 *
 * Position assertions go through scroller geometry, never Playwright
 * visibility (virtua keeps rows mounted off-screen). The host scroller is
 * addressed by `data-stream-scroller` because the aside pane mounts a second
 * timeline scroller of its own.
 */

test.describe.configure({ timeout: 150_000 })

const MESSAGE_COUNT = 40
const AGENT_REPLY_TIMEOUT = 45_000

async function seedMessages(page: Page, workspaceId: string, streamId: string, prefix: string): Promise<void> {
  const BATCH_SIZE = 5
  for (let start = 1; start <= MESSAGE_COUNT; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, MESSAGE_COUNT)
    await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) => start + i).map((n) =>
        page.request
          .post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId, content: `${prefix} msg-${String(n).padStart(3, "0")}` },
          })
          .then((r) => expectApiOk(r, `Send message ${n}`))
      )
    )
  }
}

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) throw new Error(`Could not extract IDs from URL: ${url}`)
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

function hostScroller(page: Page, streamId: string): Locator {
  return page.locator(`[data-stream-scroller="${streamId}"]`)
}

function hostRow(page: Page, streamId: string, prefix: string, num: number): Locator {
  return hostScroller(page, streamId)
    .locator("[data-message-id]")
    .filter({ hasText: `${prefix} msg-${String(num).padStart(3, "0")}` })
    .first()
}

async function scrollMetrics(
  page: Page,
  streamId: string
): Promise<{ scrollTop: number; topNum: number | null; fromBottom: number }> {
  return page.evaluate((id) => {
    const scroller = document.querySelector(`[data-stream-scroller="${id}"]`)
    if (!(scroller instanceof HTMLElement)) return { scrollTop: -1, topNum: null, fromBottom: -1 }
    const sr = scroller.getBoundingClientRect()
    let best: { num: number; top: number } | null = null
    for (const row of scroller.querySelectorAll<HTMLElement>(".message-item")) {
      const rr = row.getBoundingClientRect()
      if (rr.bottom <= sr.top + 1 || rr.top >= sr.bottom) continue
      const match = row.innerText.match(/msg-(\d+)/)
      if (!match) continue
      if (!best || rr.top < best.top) best = { num: Number(match[1]), top: rr.top }
    }
    return {
      scrollTop: Math.round(scroller.scrollTop),
      topNum: best?.num ?? null,
      fromBottom: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
    }
  }, streamId)
}

/**
 * A scroll reading the timeline has stopped changing: two identical samples
 * 250ms apart. The strict equality below is only meaningful against a host that
 * had already settled when the baseline was taken.
 */
async function settledScrollMetrics(
  page: Page,
  streamId: string
): Promise<{ scrollTop: number; topNum: number | null; fromBottom: number }> {
  let previous = await scrollMetrics(page, streamId)
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(250)
    const current = await scrollMetrics(page, streamId)
    if (current.topNum === previous.topNum && Math.abs(current.scrollTop - previous.scrollTop) <= 1) return current
    previous = current
  }
  return previous
}

async function openMessageActions(page: Page, streamId: string, prefix: string, num: number): Promise<void> {
  const row = hostRow(page, streamId, prefix, num)
  await row.hover()
  await row.getByRole("button", { name: /message actions/i }).click()
  await expect(page.getByRole("menuitem", { name: "Open an aside here" })).toBeVisible()
}

const dock = (page: Page) => page.getByTestId("aside-dock")
const pane = (page: Page) => page.getByTestId("aside-pane")
const anchorRow = (page: Page, streamId: string) => hostScroller(page, streamId).locator("[data-aside-id]").first()

async function expectNoAsideChrome(page: Page): Promise<void> {
  await expect(dock(page)).toHaveCount(0)
  await expect(pane(page)).toHaveCount(0)
}

async function expectSilent(page: Page, asideId: string): Promise<void> {
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)
  await expect(page.locator(`nav a[href*="${asideId}"]`)).toHaveCount(0)
}

test.describe("Aside — desktop surface", () => {
  let testId: string

  test.beforeEach(async ({ page }) => {
    const result = await loginAndCreateWorkspace(page, "aside")
    testId = result.testId
    // Wide enough that a 400px dock never reflows the 800px-max timeline column,
    // so any host scroll movement on open is the surface's doing, not a reflow.
    await page.setViewportSize({ width: 1600, height: 600 })
  })

  test("opens from a message beside the host without scrolling it, and the companion answers in the aside", async ({
    page,
  }) => {
    await createChannel(page, `aside-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })

    // Detach from the tail: at the tail the timeline follows the bottom, so a
    // row growing in view (the anchor row) legitimately moves the viewport —
    // that is the ordinary stick-to-bottom, not the aside's doing. The poll
    // holds until the scroller is really away from the bottom (a wheel tick
    // can be dropped under load; "top row below the tail" was already true
    // at the tail with twenty rows on screen).
    const scroller = hostScroller(page, streamId)
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 24)
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -200)
          await page.waitForTimeout(80)
          return (await scrollMetrics(page, streamId)).fromBottom
        },
        { timeout: 15000 }
      )
      .toBeGreaterThan(200)
    const anchorNum = (await settledScrollMetrics(page, streamId)).topNum
    expect(anchorNum).not.toBeNull()

    // Baseline with the row's menu already open: Playwright's hover/click
    // scrolls a partially clipped actions toolbar into view (Chromium centres
    // it, ~260px), which is the driver's doing, not the surface's. Everything
    // from the menu item click on is the aside's.
    await openMessageActions(page, streamId, prefix, anchorNum! + 1)
    const before = await settledScrollMetrics(page, streamId)
    expect(before.topNum).not.toBeNull()
    await page.getByRole("menuitem", { name: "Open an aside here" }).click()

    await expect(dock(page)).toHaveAttribute("data-surface", "dock", { timeout: 15000 })
    await expect(pane(page)).toBeVisible()
    const asideId = await pane(page).getAttribute("data-aside-id")
    expect(asideId).toBeTruthy()

    // INV-70: the host's landing is untouched — same top row, same scrollTop.
    const after = await settledScrollMetrics(page, streamId)
    expect({ topRow: after.topNum, scrollTop: after.scrollTop }).toEqual({
      topRow: before.topNum,
      scrollTop: before.scrollTop,
    })

    // The creator-only anchor row lands in the host timeline at the message.
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-aside-id", asideId!, { timeout: 15000 })
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "open")

    // Talk to Ariadne in the aside: the first turn carries the viewport
    // snapshot ("what you saw") and the companion answers in the aside pane.
    const asideEditor = pane(page).locator("[contenteditable='true']")
    await asideEditor.click()
    await page.keyboard.type("What is this about?")
    await page.keyboard.press("Meta+Enter")
    await expect(pane(page).locator(".message-item").filter({ hasText: "What is this about?" })).toBeVisible({
      timeout: 10000,
    })
    await expect(pane(page).getByText(/What you saw in/)).toBeVisible({ timeout: 15000 })
    await expect(
      pane(page)
        .locator(".message-item")
        .filter({ hasText: /stub response from the companion/ })
    ).toBeVisible({ timeout: AGENT_REPLY_TIMEOUT })
    // The host timeline never receives the aside's turns.
    await expect(hostScroller(page, streamId).getByText("What is this about?")).toHaveCount(0)
    await expectSilent(page, asideId!)
  })

  test("folds away on navigation, leaves the next stream clean, and resumes silently from the anchor row", async ({
    page,
  }) => {
    await createChannel(page, `elsewhere-${testId}`)
    const { workspaceId, streamId: otherStreamId } = extractIds(page)
    await createChannel(page, `aside-${testId}`)
    const { streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })

    // Entry point: the /aside slash command in the host composer.
    const hostEditor = page.getByRole("main").locator("[data-editor-zone='main'] [contenteditable='true']").first()
    await hostEditor.click()
    await page.keyboard.type("/aside")
    const commandPopup = page.locator("[aria-label='Slash command suggestions']")
    await expect(commandPopup).toBeVisible({ timeout: 5000 })
    await commandPopup
      .getByRole("option", { name: /^\/?aside\b/ })
      .first()
      .click()
    await page.keyboard.press("Meta+Enter")

    await expect(dock(page)).toHaveAttribute("data-surface", "dock", { timeout: 15000 })
    const asideId = await pane(page).getAttribute("data-aside-id")
    expect(asideId).toBeTruthy()
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-aside-id", asideId!, { timeout: 15000 })

    // Surface switching: fullscreen and back. There is no parked state — an
    // aside is closed and re-entered from its anchor row.
    await pane(page).getByRole("button", { name: "Aside fullscreen" }).click()
    await expect(dock(page)).toHaveAttribute("data-surface", "fullscreen")
    // Half the row: the live host keeps the other half beside the aside.
    await expect
      .poll(async () => {
        const [dockBox, hostBox] = await Promise.all([
          dock(page).boundingBox(),
          hostScroller(page, streamId).boundingBox(),
        ])
        return dockBox && hostBox ? Math.abs(dockBox.width - hostBox.width) <= 8 : false
      })
      .toBe(true)
    await pane(page).getByRole("button", { name: "Dock aside" }).click()
    await expect(dock(page)).toHaveAttribute("data-surface", "dock")

    // Leave: the next stream carries no aside chrome at all.
    await page.getByRole("link", { name: `#elsewhere-${testId}` }).click()
    await expect(page.getByRole("heading", { name: `#elsewhere-${testId}`, level: 1 })).toBeVisible({ timeout: 10000 })
    await expectNoAsideChrome(page)
    expect(page.url()).toContain(otherStreamId)

    // Return: nothing re-opens by itself; the anchor row is the way back in.
    await page.getByRole("link", { name: `#aside-${testId}` }).click()
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-aside-id", asideId!, { timeout: 15000 })
    await expectNoAsideChrome(page)
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "closed")

    // The whole row is the control, so the click lands anywhere on it.
    await anchorRow(page, streamId).click()
    await expect(dock(page)).toHaveAttribute("data-surface", "dock", { timeout: 10000 })
    await expect(pane(page)).toHaveAttribute("data-aside-id", asideId!)
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "open")
    await expectSilent(page, asideId!)
  })
})
