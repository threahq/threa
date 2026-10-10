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
 * addressed by `data-stream-scroller` because the aside column mounts a
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

const column = (page: Page) => page.getByTestId("aside-column")
// The page carries two live timelines and two real composers; this is the
// aside's own.
const asideChat = (page: Page) => page.getByTestId("aside-conversation")
const anchorRow = (page: Page, streamId: string) => hostScroller(page, streamId).locator("[data-aside-id]").first()

async function expectNoAsideChrome(page: Page): Promise<void> {
  await expect(column(page)).toHaveCount(0)
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
    // Wide enough that the default 620px aside column beside a 260px sidebar never reflows the 800px-max
    // timeline column, so any host scroll movement on open is the surface's doing, not a reflow.
    await page.setViewportSize({ width: 1920, height: 600 })
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

    await openMessageActions(page, streamId, prefix, anchorNum! + 1)
    await page.getByRole("menuitem", { name: "Open an aside here" }).click()

    await expect(column(page)).toBeVisible({ timeout: 15000 })
    const asideId = await column(page).getAttribute("data-aside-id")
    expect(asideId).toBeTruthy()

    // The aside is a column beside the page's own timeline, which stays put.
    await expect(hostScroller(page, streamId)).toHaveCount(1)
    const columnBox = (await column(page).boundingBox())!
    const hostBox = (await hostScroller(page, streamId).boundingBox())!
    expect(hostBox.x + hostBox.width).toBeLessThanOrEqual(columnBox.x + 1)

    // The creator-only anchor row lands in the host timeline at the message.
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-aside-id", asideId!, { timeout: 15000 })
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "open")
    expect((await settledScrollMetrics(page, streamId)).topNum).toBe(anchorNum)

    // Talk to Ariadne in the aside: the first turn carries the viewport
    // snapshot ("what you saw") and the companion answers in the aside pane.
    const asideEditor = asideChat(page).locator("[contenteditable='true']")
    await asideEditor.click()
    await page.keyboard.type("What is this about?")
    await page.keyboard.press("Meta+Enter")
    await expect(asideChat(page).locator(".message-item").filter({ hasText: "What is this about?" })).toBeVisible({
      timeout: 10000,
    })
    await expect(asideChat(page).getByText(/What you saw in/)).toBeVisible({ timeout: 15000 })
    await expect(
      asideChat(page)
        .locator(".message-item")
        .filter({ hasText: /stub response from the companion/ })
    ).toBeVisible({ timeout: AGENT_REPLY_TIMEOUT })
    // The host timeline never receives the aside's turns, and the anchored
    // message never adopts the aside as its thread (no card linking into it).
    await expect(hostScroller(page, streamId).getByText("What is this about?")).toHaveCount(0)
    await expect(hostScroller(page, streamId).locator(`a[href*="${asideId}"]`)).toHaveCount(0)
    await expectSilent(page, asideId!)

    // The anchor row is the aside's one attention surface (no badge, no
    // sidebar). Read and closed, it rests grey; an answer that lands while it
    // is closed lights it gold; opening it reads it.
    await page.getByRole("button", { name: "Close aside" }).click()
    await expectNoAsideChrome(page)
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-attention", "quiet")
    await expectApiOk(
      await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId: asideId, content: "And what comes next?" },
      }),
      "Ask in the closed aside"
    )
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-attention", "new", { timeout: AGENT_REPLY_TIMEOUT })
    await anchorRow(page, streamId).click()
    await expect(column(page)).toBeVisible({ timeout: 10000 })
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-attention", "open")
    await expectSilent(page, asideId!)
  })

  test("a thread opens as a tab between the host and the aside, and the host never remounts", async ({ page }) => {
    await createChannel(page, `aside-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })
    // A remount would drop this mark along with the reader's scroll and draft.
    await hostScroller(page, streamId).evaluate((element) => element.setAttribute("data-spec-mark", "kept"))
    const hostKept = page.locator(`[data-stream-scroller="${streamId}"][data-spec-mark="kept"]`)

    await openMessageActions(page, streamId, prefix, MESSAGE_COUNT)
    await page.getByRole("menuitem", { name: "Open an aside here" }).click()
    await expect(column(page)).toBeVisible({ timeout: 15000 })
    await expect(hostKept).toHaveCount(1)

    // By keyboard: the link only shows on hover, and the rows under the pointer move as the column settles.
    await hostRow(page, streamId, prefix, MESSAGE_COUNT - 2)
      .getByRole("link", { name: "Reply in thread" })
      .focus()
    await page.keyboard.press("Enter")
    const panel = page.getByTestId("panel")
    await expect(panel.getByText(/Start a new thread/)).toBeVisible({ timeout: 10000 })
    await expect(column(page)).toBeVisible()
    await expect(hostKept).toHaveCount(1)
    // Host, thread, aside: left to right, side by side.
    const [hostBox, panelBox, columnBox] = await Promise.all([
      hostScroller(page, streamId).boundingBox(),
      panel.boundingBox(),
      column(page).boundingBox(),
    ])
    expect(hostBox!.x + hostBox!.width).toBeLessThanOrEqual(panelBox!.x + 1)
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(columnBox!.x + 1)
    expect(hostBox!.width).toBeGreaterThanOrEqual(380)

    await panel.locator("[contenteditable='true']").last().click()
    await page.keyboard.type("in the thread")
    await page.keyboard.press("Meta+Enter")
    await expect(panel.locator(".message-item").filter({ hasText: "in the thread" })).toBeVisible({ timeout: 10000 })
    // The first reply turns the draft thread into a real one, and the tab follows it.
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toMatch(/^stream_/)
    const threadId = new URL(page.url()).searchParams
      .get("panel")!
      .split("-")
      .find((id) => id !== streamId)!
    // Nothing around the columns can scroll, or focus moving into them shifts the whole page: the shell once
    // overflowed sideways by the off-screen sheet it holds, and downward when its height followed its content.
    const scrolledAncestors = await hostScroller(page, streamId).evaluate((element) => {
      const scrolled: string[] = []
      for (let node = element.parentElement; node; node = node.parentElement) {
        node.scrollLeft = 10_000
        node.scrollTop = 10_000
        if (node.scrollLeft !== 0 || node.scrollTop !== 0) scrolled.push(`${node.tagName}.${node.className}`)
      }
      return scrolled
    })
    expect(scrolledAncestors).toEqual([])

    // The anchor chip scrolls the host, which is on screen, and leaves the thread open.
    // The router commits the promotion in a transition, so the page can trail the URL while the thread loads.
    await expect(column(page).getByTestId("aside-anchor-line")).toHaveAttribute(
      "href",
      new RegExp(`/s/${streamId}\\?panel=${threadId}&`)
    )
    await column(page).getByTestId("aside-anchor-line").click()
    await expect.poll(() => new URL(page.url()).searchParams.get("m")).toBeTruthy()
    expect(new URL(page.url()).pathname).toBe(`/w/${workspaceId}/s/${streamId}`)
    expect(new URL(page.url()).searchParams.get("panel")).toBe(threadId)
    await expect(panel.locator(".message-item").filter({ hasText: "in the thread" })).toBeVisible()

    // ⌥W in the aside closes the aside, not the thread beside it. Its width goes back to the host; the thread
    // and the host stay as they were.
    await asideChat(page).locator("[contenteditable='true']").click()
    await page.keyboard.press("Alt+w")
    await expectNoAsideChrome(page)
    await expect
      .poll(async () => (await hostScroller(page, streamId).boundingBox())!.width)
      .toBeGreaterThanOrEqual(hostBox!.width + columnBox!.width - 1)
    await expect(panel.locator(".message-item").filter({ hasText: "in the thread" })).toBeVisible()
    expect(new URL(page.url()).searchParams.get("panel")).toBe(threadId)
    await expect(hostKept).toHaveCount(1)
  })

  test("turns into a sheet holding the thread when a thread leaves it no room beside the host", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 })
    await createChannel(page, `aside-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })
    await openMessageActions(page, streamId, prefix, MESSAGE_COUNT)
    await page.getByRole("menuitem", { name: "Open an aside here" }).click()

    // The host and the aside fit side by side; nothing spills past the window.
    await expect(column(page)).toBeVisible({ timeout: 15000 })
    await expect
      .poll(async () => {
        const box = (await column(page).boundingBox())!
        return box.x + box.width
      })
      .toBeLessThanOrEqual(1100 + 1)
    const asideId = await column(page).getAttribute("data-aside-id")

    // A thread on top leaves no room for three columns, so the aside becomes the sheet and holds the thread.
    await hostRow(page, streamId, prefix, MESSAGE_COUNT - 2)
      .getByRole("link", { name: "Reply in thread" })
      .focus()
    await page.keyboard.press("Enter")
    const sheet = page.getByTestId("aside-sheet")
    await expect(sheet).toBeVisible({ timeout: 10000 })
    await expect(column(page)).toHaveCount(0)
    await expect(sheet.getByText(/Start a new thread/)).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("panel").locator("[data-editor-zone]")).toHaveCount(0)
    await expect(sheet.getByTestId("aside-conversation")).toHaveCount(0)

    // The sheet stands in for the column and owns no history entry, so the
    // thread's Close closes the thread, and the aside gets its column back.
    await sheet.getByRole("button", { name: "Close", exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull()
    await expect(column(page)).toHaveAttribute("data-aside-id", asideId!, { timeout: 10000 })
    await expect(sheet).toHaveCount(0)

    // Back, likewise, takes the thread it reopens, not the aside.
    await hostRow(page, streamId, prefix, MESSAGE_COUNT - 2)
      .getByRole("link", { name: "Reply in thread" })
      .focus()
    await page.keyboard.press("Enter")
    await expect(sheet).toBeVisible({ timeout: 10000 })
    await page.goBack()
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull()
    await expect(column(page)).toHaveAttribute("data-aside-id", asideId!, { timeout: 10000 })
  })

  test("opened as a sheet over an open thread, leaves the thread's Close to the thread", async ({ page }) => {
    // Too narrow to split, with a fine pointer: the aside is a sheet from the start.
    await page.setViewportSize({ width: 900, height: 700 })
    await createChannel(page, `aside-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })
    await hostRow(page, streamId, prefix, MESSAGE_COUNT - 2)
      .getByRole("link", { name: "Reply in thread" })
      .focus()
    await page.keyboard.press("Enter")
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).not.toBeNull()

    await page.keyboard.press("ControlOrMeta+Shift+KeyK")
    await page.getByText("Open an aside here").first().click()
    const sheet = page.getByTestId("aside-sheet")
    await expect(sheet).toHaveAttribute("data-view", "panel", { timeout: 15000 })
    await expect(sheet.getByText(/Start a new thread/)).toBeVisible({ timeout: 10000 })

    // The sheet pushed no entry over the thread's, so its Close closes the thread and the aside stays.
    await sheet.getByRole("button", { name: "Close", exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull()
    await expect(sheet).toHaveAttribute("data-view", "aside", { timeout: 10000 })
    await expect(sheet.getByTestId("aside-conversation")).toBeVisible()

    // ⌥W in the sheet's aside closes the aside, as it does in the column.
    await sheet.getByTestId("aside-conversation").locator("[contenteditable='true']").click()
    await page.keyboard.press("Alt+w")
    await expect(sheet).toHaveCount(0)
  })

  test("a draft expanded beside an open aside floats over both, and the aside stays out of reach until it docks", async ({
    page,
  }) => {
    await createChannel(page, `aside-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })
    await openMessageActions(page, streamId, prefix, MESSAGE_COUNT)
    await page.getByRole("menuitem", { name: "Open an aside here" }).click()
    await expect(column(page)).toBeVisible({ timeout: 15000 })

    const main = page.locator('[data-editor-zone="main"]')
    await main.locator("[contenteditable='true']").last().click()
    await page.keyboard.type("a longer thought")
    await main.getByRole("link", { name: "Expand editor into a pane" }).click()
    const compose = `compose:${streamId}`
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe(`${compose}**`)
    const editor = page
      .locator(`[data-panel-tab="${compose}"]`)
      .getByRole("textbox", { name: "Expanded message editor" })
    await expect(editor).toHaveText("a longer thought")
    await expect(page.locator('[inert]:has([data-testid="aside-column"])')).toHaveCount(1)

    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe(compose)
    await expect(page.locator('[inert]:has([data-testid="aside-column"])')).toHaveCount(0)
    await expect(editor).toHaveText("a longer thought")
    await expect(column(page)).toBeVisible()
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

    await expect(column(page)).toBeVisible({ timeout: 15000 })
    const asideId = await column(page).getAttribute("data-aside-id")
    expect(asideId).toBeTruthy()
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-aside-id", asideId!, { timeout: 15000 })

    // One host timeline: the page's own, beside the column.
    await expect(hostScroller(page, streamId)).toHaveCount(1)
    await expect(column(page).getByRole("group", { name: "Aside surface" })).toHaveCount(0)

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
    await expect(column(page)).toBeVisible({ timeout: 10000 })
    await expect(column(page)).toHaveAttribute("data-aside-id", asideId!)
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "open")
    await expectSilent(page, asideId!)
  })
})
