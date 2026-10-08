import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The pane shortcuts move between tabs and panes and close and reopen tabs,
 * keeping `?panel=` in step and landing focus in the composer of the pane
 * they move to, so typing carries on there.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function seedThreads(page: Page, count: number) {
  await loginAndCreateWorkspace(page, "panel-shortcuts")
  await createChannel(page, `keys-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const threads: string[] = []
  for (let index = 0; index < count; index++) {
    const parentId = await post(page, workspaceId, streamId, `parent number ${index + 1}`)
    const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "thread", parentStreamId: streamId, parentAnchorId: parentId },
    })
    await expectApiOk(response, "create thread")
    const threadId = ((await response.json()) as { stream: { id: string } }).stream.id
    await post(page, workspaceId, threadId, `reply in thread ${index + 1}`)
    threads.push(threadId)
  }
  return { workspaceId, streamId, threads }
}

const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const route = (page: Page) => ({
  stream: new URL(page.url()).pathname.match(/\/s\/([^/]+)/)![1],
  panel: panelParam(page),
})

/** The pane holding the focused composer: a panel id, "main", or null when focus isn't in a composer. */
function focusedComposer(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    if (!active?.isContentEditable) return null
    if (active.closest('[data-editor-zone="main"]')) return "main"
    return active.closest("[data-panel-tab]")?.getAttribute("data-panel-tab") ?? null
  })
}

async function openPanels(page: Page, workspaceId: string, streamId: string, panel: string, last: number) {
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${panel}`)
  await expect(page.getByTestId("panel").getByText(`reply in thread ${last}`, { exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

test("should switch, close and reopen tabs from the keyboard, landing in each tab's composer", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 3)
  const [a, b, c] = threads
  // The pane worked in is the route's stream, so the channel is the first column of the rest.
  const beside = (panel: string) => `${streamId}-${panel}`
  await openPanels(page, workspaceId, streamId, `${a}.${b}.${c}`, 3)

  await tabPane(page, c).locator('[contenteditable="true"]').last().click()
  await expect.poll(() => focusedComposer(page)).toBe(c)

  await page.keyboard.press("Alt+BracketLeft")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}.${b}*.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(b)
  await page.keyboard.press("Alt+BracketLeft")
  await expect.poll(() => focusedComposer(page)).toBe(a)
  await page.keyboard.press("Alt+BracketLeft")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}.${b}.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(c)
  await page.keyboard.press("Alt+BracketRight")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}*.${b}.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(a)

  // Typing carries on in the tab landed on.
  await page.keyboard.type("still here")
  await expect(tabPane(page, a).locator('[contenteditable="true"]').last()).toHaveText("still here")

  // Presses faster than the URL settles each act on the layout the one before left.
  await page.keyboard.press("Alt+BracketRight")
  await page.keyboard.press("Alt+BracketRight")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}.${b}.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(c)
  await page.keyboard.press("Alt+BracketLeft")
  await page.keyboard.press("Alt+BracketLeft")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}*.${b}.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(a)

  // Coming back by mouse to where the last press acted doesn't hold up the next.
  await page.keyboard.press("Alt+BracketRight")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}.${b}*.${c}`))
  await tabPane(page, b).getByRole("link", { name: "parent number 1" }).click()
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}*.${b}.${c}`))
  await page.keyboard.press("Alt+BracketRight")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}.${b}*.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(b)
  await page.keyboard.press("Alt+BracketLeft")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}*.${b}.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(a)

  // A press right after a tab click waits for it, however long since the last shortcut.
  await page.waitForTimeout(2_100)
  await tabPane(page, a).getByRole("link", { name: "parent number 2" }).click()
  await page.keyboard.press("Alt+BracketLeft")
  await expect.poll(() => panelParam(page)).toBe(beside(`${a}*.${b}.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(a)

  await page.keyboard.press("Alt+w")
  await expect.poll(() => panelParam(page)).toBe(beside(`${b}*.${c}`))
  await expect.poll(() => focusedComposer(page)).toBe(b)

  await page.keyboard.press("Alt+Shift+T")
  await expect.poll(() => panelParam(page)).toBe(beside(`${b}.${c}.${a}`))
  await expect.poll(() => focusedComposer(page)).toBe(a)

  // Reopening straight after a close brings back the tab just closed.
  await page.keyboard.press("Alt+w")
  await page.keyboard.press("Alt+Shift+T")
  await expect.poll(() => panelParam(page)).toBe(beside(`${b}.${c}.${a}`))
  await expect.poll(() => focusedComposer(page)).toBe(a)

  // Closing the last tab lands back in the stream's composer.
  const openCount = () => (panelParam(page)?.split(".") ?? []).length
  for (const remaining of [2, 1]) {
    await page.keyboard.press("Alt+w")
    await expect.poll(openCount).toBe(remaining)
  }
  const last = panelParam(page)!.split("-")[1]
  await page.keyboard.press("Alt+w")
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect.poll(() => focusedComposer(page)).toBe("main")

  // With nothing left open, the last tab closed still comes back, and a close
  // pressed before it shows still closes it.
  await page.keyboard.press("Alt+Shift+T")
  await page.keyboard.press("Alt+w")
  await expect.poll(() => panelParam(page)).toBeNull()
  await page.keyboard.press("Alt+Shift+T")
  await expect.poll(() => panelParam(page)).toBe(beside(last))
  await expect.poll(() => focusedComposer(page)).toBe(last)
})

test("should step focus through the main view and the panes beside it", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  await openPanels(page, workspaceId, streamId, `${a}-${b}`, 2)
  await expect(tabPane(page, a).getByText("reply in thread 1")).toBeVisible()

  await page.locator('[data-editor-zone="main"] [contenteditable="true"]').last().click()
  await expect.poll(() => focusedComposer(page)).toBe("main")

  for (const expected of [a, b, "main"]) {
    await page.keyboard.press("Alt+Period")
    await expect.poll(() => focusedComposer(page)).toBe(expected)
  }
  await page.keyboard.press("Alt+Comma")
  await expect.poll(() => focusedComposer(page)).toBe(b)
  // The pane moved to is the route's stream; the arrangement stays as it was.
  await expect.poll(() => route(page)).toEqual({ stream: b, panel: `${streamId}-${a}-${b}` })

  // Closing works on the pane worked in, not the one in front of it in the URL.
  await page.keyboard.press("Alt+w")
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}` })

  // The channel is a pane like the rest: closing it from its composer leaves the thread, worked in.
  await page.locator('[data-editor-zone="main"] [contenteditable="true"]').last().click()
  await expect.poll(() => route(page)).toEqual({ stream: streamId, panel: a })
  await page.keyboard.press("Alt+w")
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: null })
  await expect.poll(() => focusedComposer(page)).toBe("main")
})

test("should act on each queued press after the one before it", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 3)
  const [a, b, c] = threads
  await openPanels(page, workspaceId, streamId, `${a}.${c}-${b}`, 2)
  await tabPane(page, c).locator('[contenteditable="true"]').last().click()

  // Moving to the next pane changes no URL, so the close queued behind it must still see the move.
  // One synchronous burst, so no render lands between the presses.
  await page.evaluate(() => {
    for (const [key, code] of [
      ["]", "BracketRight"],
      [".", "Period"],
      ["w", "KeyW"],
    ]) {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, code, altKey: true, bubbles: true, cancelable: true })
      )
    }
  })
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}*.${c}`)
})

test("should switch the tabs of a split folded into one section without waiting on the URL", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  await openPanels(page, workspaceId, streamId, `${a}-${b}`, 2)
  await tabPane(page, b).locator('[contenteditable="true"]').last().click()

  // Each column keeps its own tab in front, so switching between them leaves the URL as it was.
  await page.keyboard.press("Alt+BracketLeft")
  await expect.poll(() => focusedComposer(page)).toBe(a)
  await page.keyboard.press("Alt+BracketRight")
  await expect.poll(() => focusedComposer(page), { timeout: 1_000 }).toBe(b)
  await expect(tabPane(page, b).getByText("reply in thread 2")).toBeVisible()
  await expect.poll(() => route(page)).toEqual({ stream: b, panel: `${streamId}-${a}-${b}` })
})

test.describe("installed", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const matchMedia = window.matchMedia.bind(window)
      window.matchMedia = (query: string) =>
        query === "(display-mode: standalone)"
          ? ({ ...matchMedia(query), matches: true, media: query } as MediaQueryList)
          : matchMedia(query)
    })
  })

  test("should take over the app's own tab keys", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    const { workspaceId, streamId, threads } = await seedThreads(page, 2)
    const [a, b] = threads
    await openPanels(page, workspaceId, streamId, `${a}.${b}`, 2)
    await tabPane(page, b).locator('[contenteditable="true"]').last().click()

    await page.keyboard.press("Control+Tab")
    await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}*.${b}`)
    await expect.poll(() => focusedComposer(page)).toBe(a)
    await page.keyboard.press("Control+Shift+Tab")
    await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}.${b}`)
    await expect.poll(() => focusedComposer(page)).toBe(b)

    await page.keyboard.press("Control+w")
    await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}`)
    await page.keyboard.press("Control+Shift+T")
    await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}.${b}`)
    await expect.poll(() => focusedComposer(page)).toBe(b)
  })
})
