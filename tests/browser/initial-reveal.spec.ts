import { test, expect, type Browser, type Page } from "@playwright/test"
import { createChannel, expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * One reveal. A cold load paints the sidebar and every pane on show in the
 * same frame: nothing for a young load, skeletons for a slow one, then all the
 * content at once, never the sidebar first and the panes one by one after it.
 *
 * A MutationObserver installed before the app script runs records when each
 * surface first shows content: the sidebar its stream rows, a pane its content
 * (a timeline its message rows or its empty state) with no settle mask or skeleton over it.
 * Covered tabs are not on show and don't count. Every pane kind is on show in
 * one of the layouts, so a kind that never reports ready trips the reveal cap's
 * console warning, which fails the test by name.
 */

test.describe.configure({ timeout: 180_000 })
/** Wide enough that four sections sit side by side instead of folding into a tab group. */
test.use({ viewport: { width: 1920, height: 900 } })

/** Two frames at 60Hz: the observer can land between a commit and its paint. */
const SAME_FRAME_MS = 34

type FirstPaints = Record<string, number>

/** Runs in the page from document start. Serialised with `toString()`, so no outer references. */
function installRevealObserver(): void {
  const firstPaints: Record<string, number> = {}
  ;(window as unknown as { __firstPaints: Record<string, number> }).__firstPaints = firstPaints
  const visible = (element: Element) => element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
  // Panes that list things rather than a timeline have no message rows to wait for.
  const hasTimeline = (id: string) => !/^(convs|context|compose|page):/.test(id)
  const showsContent = (id: string, root: Element) =>
    visible(root) &&
    !root.querySelector('[data-testid="settle-mask"], .animate-pulse') &&
    (!hasTimeline(id) ||
      [...root.querySelectorAll("[data-message-id]")].some(visible) ||
      !!root.textContent?.includes("No messages yet"))
  const record = () => {
    const now = Math.round(performance.now())
    const nav = document.querySelector('[role="navigation"][aria-label="Sidebar navigation"]')
    if (
      nav &&
      firstPaints.sidebar === undefined &&
      visible(nav) &&
      !nav.querySelector(".animate-pulse") &&
      nav.querySelector('a[href*="/s/"]')
    ) {
      firstPaints.sidebar = now
    }
    for (const pane of document.querySelectorAll("[data-panel-tab]")) {
      const id = pane.getAttribute("data-panel-tab")!
      if (firstPaints[id] === undefined && showsContent(id, pane)) firstPaints[id] = now
    }
  }
  new MutationObserver(record).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "data-testid"],
  })
}

const OBSERVER_SOURCE = `${installRevealObserver.toString()}\ninstallRevealObserver()`

async function post(page: Page, workspaceId: string, streamId: string, content: string, conversation = false) {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, content, ...(conversation ? { conversation: { intent: "new" } } : {}) },
  })
  await expectApiOk(response, `post ${content}`)
  return (await response.json()) as { message: { id: string }; conversationId?: string }
}

async function seed(page: Page) {
  await loginAndCreateWorkspace(page, "initial-reveal")
  await createChannel(page, `reveal-empty-${Date.now().toString(36)}`)
  const empty = page.url().match(/\/s\/([^/?]+)/)![1]
  await createChannel(page, `reveal-b-${Date.now().toString(36)}`)
  const other = page.url().match(/\/s\/([^/?]+)/)![1]
  await createChannel(page, `reveal-a-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  for (let index = 0; index < 30; index++) await post(page, workspaceId, streamId, `channel message ${index}`)
  for (let index = 0; index < 30; index++) await post(page, workspaceId, other, `other message ${index}`)
  const parent = await post(page, workspaceId, streamId, "thread parent")
  const thread = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamId, parentAnchorId: parent.message.id },
  })
  await expectApiOk(thread, "create thread")
  const threadId = ((await thread.json()) as { stream: { id: string } }).stream.id
  await post(page, workspaceId, threadId, "reply in the thread")
  const { conversationId } = await post(page, workspaceId, streamId, "a conversation topic", true)
  return { workspaceId, streamId, other, empty, threadId, conversationId: conversationId! }
}

/** Signed in as `page`, with nothing in IndexedDB: the first load of a new device. */
async function freshPage(browser: Browser, page: Page): Promise<Page> {
  const context = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: page.viewportSize(),
  })
  return context.newPage()
}

async function coldLoad(page: Page, url: string): Promise<{ paints: FirstPaints; onShow: string[] }> {
  await page.goto(url, { waitUntil: "commit" })
  await expect(page.locator("[data-panel-tab]").first()).toBeVisible({ timeout: 30_000 })
  // Past REVEAL_CAP_MS, so a pane that never reports has surfaced the cap warning by now.
  await page.waitForTimeout(4_000)
  return page.evaluate(() => ({
    paints: (window as unknown as { __firstPaints: Record<string, number> }).__firstPaints,
    onShow: [...document.querySelectorAll("[data-panel-tab]")]
      .filter((pane) => pane.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
      .map((pane) => pane.getAttribute("data-panel-tab")!),
  }))
}

test("should paint the sidebar and every pane on show in the same frame on a cold load", async ({ page, browser }) => {
  const { workspaceId, streamId, other, empty, threadId, conversationId } = await seed(page)
  const capWarnings: string[] = []
  const observe = async (target: Page) => {
    await target.addInitScript({ content: OBSERVER_SOURCE })
    target.on("console", (message) => {
      if (message.text().includes("[CoordinatedLoading] Revealing without")) capWarnings.push(message.text())
    })
    return target
  }
  const cachedPage = await observe(page)
  const newDevicePage = await observe(await freshPage(browser, page))

  const fourKinds = `s/${streamId}?panel=${threadId}-${other}-conv:${conversationId}`
  const layouts: Record<string, { page: Page; path: string; panes: number }> = {
    "four kinds on a new device": { page: newDevicePage, path: fourKinds, panes: 4 },
    "channel and thread": { page: cachedPage, path: `s/${streamId}?panel=${threadId}`, panes: 2 },
    "four kinds side by side": { page: cachedPage, path: fourKinds, panes: 4 },
    "an empty stream": { page: cachedPage, path: `s/${empty}?panel=${streamId}`, panes: 2 },
    "list panes": {
      page: cachedPage,
      path: `s/${streamId}?panel=convs:${streamId}-context:${streamId}-compose:${other}`,
      panes: 4,
    },
    "a page beside a stream": { page: cachedPage, path: `board?panel=${streamId}`, panes: 2 },
  }
  const origin = new URL(page.url()).origin
  const results: Record<string, { paints: FirstPaints; spread: number }> = {}
  for (const [name, layout] of Object.entries(layouts)) {
    const { paints, onShow } = await coldLoad(layout.page, `${origin}/w/${workspaceId}/${layout.path}`)
    expect(onShow, `${name}: panes on show`).toHaveLength(layout.panes)
    const times = ["sidebar", ...onShow].map((surface) => paints[surface])
    results[name] = { paints, spread: Math.max(...times) - Math.min(...times) }
    expect(times, `${name}: every surface paints (${JSON.stringify(paints)})`).not.toContain(undefined)
  }
  expect(capWarnings).toEqual([])
  for (const [name, { spread }] of Object.entries(results)) {
    expect(spread, `${name}: ${JSON.stringify(results[name].paints)}`).toBeLessThanOrEqual(SAME_FRAME_MS)
  }
})
