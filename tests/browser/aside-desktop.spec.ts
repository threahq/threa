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
 * addressed by `data-stream-scroller` because the aside pane mounts a
 * timeline scroller of its own.
 */

test.describe.configure({ timeout: 150_000 })

const MESSAGE_COUNT = 40
const AGENT_REPLY_TIMEOUT = 45_000

async function seedMessages(page: Page, workspaceId: string, streamId: string, prefix: string): Promise<void> {
  // In order: the tests pick rows by number and expect msg-(n+1) right below msg-n.
  for (let n = 1; n <= MESSAGE_COUNT; n++) {
    await expectApiOk(
      await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: `${prefix} msg-${String(n).padStart(3, "0")}` },
      }),
      `Send message ${n}`
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

const asidePane = (page: Page) => page.getByTestId("aside-panel")
// The page carries two live timelines and two real composers; this is the
// aside's own.
const asideChat = (page: Page) => page.getByTestId("aside-conversation")
const anchorRow = (page: Page, streamId: string) => hostScroller(page, streamId).locator("[data-aside-id]").first()

async function expectNoAsideChrome(page: Page): Promise<void> {
  await expect(asidePane(page)).toHaveCount(0)
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
    // Wide enough that the default 480px pane beside a 260px sidebar never reflows the 800px-max timeline
    // column, so any host scroll movement on open is the surface's doing, not a reflow.
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

    await expect(asidePane(page)).toBeVisible({ timeout: 15000 })
    const asideId = await asidePane(page).getAttribute("data-aside-id")
    expect(asideId).toBeTruthy()

    // The aside is a pane beside the page's own timeline, which stays put.
    await expect(hostScroller(page, streamId)).toHaveCount(1)
    const asideBox = (await asidePane(page).boundingBox())!
    const hostBox = (await hostScroller(page, streamId).boundingBox())!
    expect(hostBox.x + hostBox.width).toBeLessThanOrEqual(asideBox.x + 1)

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
    // "What you saw in …" names the host, already on show beside the aside: it flashes, and nothing moves.
    const at = page.url()
    await asideChat(page)
      .getByRole("link", { name: /What you saw in/ })
      .click()
    await expect(page.locator(`[data-panel-tab="${streamId}"]`)).toHaveClass(/pane-flash/)
    expect(page.url()).toBe(at)
    await expect(asidePane(page)).toBeVisible()
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
    await expect(asidePane(page)).toBeVisible({ timeout: 10000 })
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-attention", "open")
    await expectSilent(page, asideId!)
  })

  test("a thread opens as a tab beside the aside, and neither the host nor the aside remounts", async ({ page }) => {
    await createChannel(page, `aside-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })
    // A remount would drop these marks along with the reader's scroll and draft.
    await hostScroller(page, streamId).evaluate((element) => element.setAttribute("data-spec-mark", "kept"))
    const hostKept = page.locator(`[data-stream-scroller="${streamId}"][data-spec-mark="kept"]`)

    await openMessageActions(page, streamId, prefix, MESSAGE_COUNT)
    await page.getByRole("menuitem", { name: "Open an aside here" }).click()
    await expect(asidePane(page)).toBeVisible({ timeout: 15000 })
    await asidePane(page).evaluate((element) => element.setAttribute("data-spec-mark", "kept"))
    const asideKept = page.locator('[data-testid="aside-panel"][data-spec-mark="kept"]')
    const aside = `aside:${streamId}`

    // By keyboard: the link only shows on hover, and the rows under the pointer move as the pane settles.
    await hostRow(page, streamId, prefix, MESSAGE_COUNT - 2)
      .getByRole("link", { name: "Reply in thread" })
      .focus()
    await page.keyboard.press("Enter")
    const panel = page.getByTestId("panel")
    await expect(panel.getByText(/Start a new thread/)).toBeVisible({ timeout: 10000 })
    expect(new URL(page.url()).searchParams.get("panel")).toMatch(new RegExp(`^${aside}\\.draft:`))
    await expect(asidePane(page)).toBeHidden()
    await expect(asideKept).toHaveCount(1)
    await expect(hostKept).toHaveCount(1)

    await panel.locator("[contenteditable='true']").last().click()
    await page.keyboard.type("in the thread")
    await page.keyboard.press("Meta+Enter")
    await expect(panel.locator(".message-item").filter({ hasText: "in the thread" })).toBeVisible({ timeout: 10000 })
    // The first reply turns the draft thread into a real one, and the tab follows it. The promotion also
    // writes the host's own pane into the layout, which shows nothing new.
    const panes = () => new URL(page.url()).searchParams.get("panel")?.replace(`${streamId}-`, "")
    await expect.poll(panes).toMatch(new RegExp(`^${aside}\\.stream_\\w+$`))
    const threadId = panes()!.slice(aside.length + 1)
    // Nothing around the panes can scroll, or focus moving into them shifts the whole page: the shell once
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

    // Its tab brings the aside back as it was. The router commits the promotion in a transition, so the strip
    // can trail the URL while the thread loads.
    const asideTab = page
      .getByRole("navigation", { name: "Panel tabs" })
      .getByRole("link", { name: "Aside", exact: true })
    await expect(asideTab).toHaveAttribute("href", new RegExp(threadId))
    await asideTab.click()
    await expect(asidePane(page)).toBeVisible()
    await expect(asideKept).toHaveCount(1)
    expect(panes()).toBe(`${aside}*.${threadId}`)

    // The anchor chip scrolls the host, which is on screen, and leaves the panes as they are.
    await asidePane(page).getByTestId("aside-anchor-line").click()
    await expect.poll(() => new URL(page.url()).searchParams.get("m")).toBeTruthy()
    expect(new URL(page.url()).pathname).toBe(`/w/${workspaceId}/s/${streamId}`)
    expect(panes()).toBe(`${aside}*.${threadId}`)
    // The jump works in the host: `?m` is the pane's in front.
    await expect(page.locator(`[data-panel-tab="${streamId}"]`)).toHaveAttribute("data-front-panel", "true")

    // ⌥W in the aside closes the aside, not the thread beside it.
    await asideChat(page).locator("[contenteditable='true']").click()
    await expect(page.locator(`[data-panel-tab="${aside}"]`)).toHaveAttribute("data-front-panel", "true")
    await page.keyboard.press("Alt+w")
    await expectNoAsideChrome(page)
    await expect.poll(panes).toBe(threadId)
    await expect(panel.locator(".message-item").filter({ hasText: "in the thread" })).toBeVisible()
    await expect(hostKept).toHaveCount(1)
  })

  test("lives in the URL as a pane of its host: Back closes it, and a reload leaves it closed", async ({ page }) => {
    await createChannel(page, `aside-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })
    const panelParam = () => new URL(page.url()).searchParams.get("panel")

    await openMessageActions(page, streamId, prefix, MESSAGE_COUNT)
    await page.getByRole("menuitem", { name: "Open an aside here" }).click()
    await expect(asidePane(page)).toBeVisible({ timeout: 15000 })
    const asideId = await asidePane(page).getAttribute("data-aside-id")
    // Where it sits, never which aside: that stays out of a link anyone else could open.
    expect(panelParam()).toBe(`aside:${streamId}`)
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "open", { timeout: 15000 })

    await page.goBack()
    await expectNoAsideChrome(page)
    expect(panelParam()).toBeNull()
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "closed")

    await anchorRow(page, streamId).click()
    await expect(asidePane(page)).toHaveAttribute("data-aside-id", asideId!, { timeout: 10000 })
    expect(panelParam()).toBe(`aside:${streamId}`)

    // The anchor chip flashes its row in the host, the stream the aside belongs to.
    await asidePane(page).getByTestId("aside-anchor-line").click()
    await expect.poll(() => new URL(page.url()).searchParams.get("m")).toBeTruthy()
    await expect(hostScroller(page, streamId).locator(".animate-highlight-flash")).toContainText(
      `${prefix} msg-${String(MESSAGE_COUNT).padStart(3, "0")}`,
      { timeout: 10000 }
    )
    expect(panelParam()).toBe(`aside:${streamId}`)

    // The pane names no aside, so a reload has none to show and drops it.
    await page.reload()
    await expect(hostRow(page, streamId, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })
    await expect.poll(panelParam).toBeNull()
    await expectNoAsideChrome(page)
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "closed")
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

    // ⌥W in the sheet's aside closes the aside, as it does in the pane.
    await sheet.getByTestId("aside-conversation").locator("[contenteditable='true']").click()
    await page.keyboard.press("Alt+w")
    await expect(sheet).toHaveCount(0)
  })

  test("a draft expanded beside an open aside floats over it, and the aside stays out of reach until it docks", async ({
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
    await expect(asidePane(page)).toBeVisible({ timeout: 15000 })

    const main = page.locator('[data-editor-zone="main"]')
    await main.locator("[contenteditable='true']").last().click()
    await page.keyboard.type("a longer thought")
    await main.getByRole("link", { name: "Expand editor into a pane" }).click()
    const compose = `compose:${streamId}`
    const aside = `aside:${streamId}`
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe(`${aside}.${compose}**`)
    const editor = page
      .locator(`[data-panel-tab="${compose}"]`)
      .getByRole("textbox", { name: "Expanded message editor" })
    await expect(editor).toHaveText("a longer thought")
    await expect(page.locator('[inert]:has([data-testid="aside-panel"])')).toHaveCount(1)

    await page.locator(`[data-panel-tab="${compose}"]`).getByRole("button", { name: "Restore to layout" }).click()
    // Docked, it is a tab beside the aside's.
    await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe(`${aside}.${compose}`)
    await expect(editor).toHaveText("a longer thought")
    await page.getByRole("navigation", { name: "Panel tabs" }).getByRole("link", { name: "Aside", exact: true }).click()
    await expect(asidePane(page)).toBeVisible()
    await expect(page.locator('[inert]:has([data-testid="aside-panel"])')).toHaveCount(0)
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

    await expect(asidePane(page)).toBeVisible({ timeout: 15000 })
    const asideId = await asidePane(page).getAttribute("data-aside-id")
    expect(asideId).toBeTruthy()
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-aside-id", asideId!, { timeout: 15000 })

    // One host timeline: the page's own, beside the pane.
    await expect(hostScroller(page, streamId)).toHaveCount(1)
    await expect(asidePane(page).getByRole("group", { name: "Aside surface" })).toHaveCount(0)

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
    await expect(asidePane(page)).toBeVisible({ timeout: 10000 })
    await expect(asidePane(page)).toHaveAttribute("data-aside-id", asideId!)
    await expect(anchorRow(page, streamId)).toHaveAttribute("data-state", "open")
    await expectSilent(page, asideId!)
  })
})
