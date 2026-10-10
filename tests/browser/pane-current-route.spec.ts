import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The route names the stream pane the reader works in and `?panel=` holds the
 * rest, so working in another pane, going back and forth, reloading and
 * rearranging panes only rewrites the URL: every pane keeps its DOM nodes
 * (expando tags survive) and its scroll, and ⌘F searches the pane worked in.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

const streamIdOf = (page: Page) => new URL(page.url()).pathname.match(/\/s\/([^/]+)/)![1]
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const pane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
/** A pane's timeline scroller: virtualized for a channel, plain for a thread. */
const scroller = (page: Page, id: string) =>
  pane(page, id)
    .locator("[data-stream-scroller], .overflow-y-auto")
    .filter({ has: page.locator("[data-message-id]") })
    .last()
const searchIn = (page: Page, id: string) => pane(page, id).getByPlaceholder("Search in conversation...")
const sidebarRow = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Sidebar navigation" }).getByRole("link", { name: `#${name}` })
const tabLink = (page: Page, of: string, id: string) =>
  pane(page, of).getByRole("navigation", { name: "Panel tabs" }).locator(`[data-tab-id="${id}"] a`)

async function tag(target: Locator, name: string) {
  await target.first().evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__routeTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.first().evaluate((el) => (el as unknown as Record<string, string>).__routeTag ?? null)
}

const scrollTopOf = (target: Locator) => target.first().evaluate((el) => Math.round(el.scrollTop))

/** Works in `id`'s pane by clicking into its composer. */
async function workIn(page: Page, id: string) {
  await pane(page, id).locator('[contenteditable="true"]').last().click()
}

/** Waits for `target` to stop moving and returns its scroll offset. */
async function settledScroll(target: Locator): Promise<number> {
  let last = Number.NaN
  await expect
    .poll(async () => {
      const previous = last
      last = await scrollTopOf(target)
      return last === previous
    })
    .toBe(true)
  return last
}

async function seedChannelWithThread(page: Page) {
  await loginAndCreateWorkspace(page, "pane-route")
  await createChannel(page, `route-${Date.now().toString(36)}`)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const channel = streamIdOf(page)
  const ids: string[] = []
  for (let i = 0; i < 30; i++) {
    ids.push(await post(page, workspaceId, channel, `channel line ${String(i).padStart(2, "0")} gives it a scroll`))
  }
  const parentId = ids[29]
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: channel, parentAnchorId: parentId },
  })
  await expectApiOk(response, "create thread")
  const thread = ((await response.json()) as { stream: { id: string } }).stream.id
  for (let i = 0; i < 30; i++) {
    await post(page, workspaceId, thread, `thread line ${String(i).padStart(2, "0")} gives it a scroll`)
  }
  await page.reload()
  await expect(scroller(page, channel)).toBeVisible({ timeout: 30_000 })
  await page
    .locator(`[data-message-id="${parentId}"]`)
    .first()
    .getByRole("link", { name: /30 replies/i })
    .click()
  await expect(pane(page, thread).getByText("thread line 29")).toBeVisible({ timeout: 30_000 })
  return { channel, thread }
}

test("should move the route to the pane worked in without remounting or scrolling either pane", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { channel, thread } = await seedChannelWithThread(page)

  await workIn(page, channel)
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: channel,
      panel: thread,
    })
  await tag(scroller(page, channel), "channel")
  await tag(scroller(page, thread), "thread")
  await scroller(page, channel).evaluate((el) => el.scrollBy(0, -300))
  await scroller(page, thread).evaluate((el) => el.scrollBy(0, -200))
  const channelTop = await settledScroll(scroller(page, channel))
  const threadTop = await settledScroll(scroller(page, thread))

  // (a) Working in the thread names it in the route; the channel stays in `?panel=`.
  await workIn(page, thread)
  await expect.poll(() => streamIdOf(page)).toBe(thread)
  expect(panelParam(page)).toBe(`${channel}-${thread}`)
  await expect(pane(page, thread)).toHaveAttribute("data-front-panel", "true")
  expect({
    channel: await tagOf(scroller(page, channel)),
    thread: await tagOf(scroller(page, thread)),
    channelTop: await scrollTopOf(scroller(page, channel)),
    threadTop: await scrollTopOf(scroller(page, thread)),
  }).toEqual({ channel: "channel", thread: "thread", channelTop, threadTop })

  // (c) ⌘F searches the pane worked in, a thread here, and not the channel beside it.
  await page.keyboard.press("ControlOrMeta+f")
  await expect(searchIn(page, thread)).toBeFocused()
  await expect(searchIn(page, channel)).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(searchIn(page, thread)).toHaveCount(0)

  // And back: the channel names the route again, still the same nodes.
  await workIn(page, channel)
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: channel,
      panel: thread,
    })
  await page.keyboard.press("ControlOrMeta+f")
  await expect(searchIn(page, channel)).toBeFocused()
  await expect(searchIn(page, thread)).toHaveCount(0)
  expect({
    channel: await tagOf(scroller(page, channel)),
    thread: await tagOf(scroller(page, thread)),
  }).toEqual({ channel: "channel", thread: "thread" })
})

test("should land back, forward and reload on the pane the route names", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { channel, thread } = await seedChannelWithThread(page)

  await workIn(page, thread)
  await expect.poll(() => streamIdOf(page)).toBe(thread)
  const threadUrl = page.url()

  // Working in a pane is no step of its own: back closes the thread the timeline opened.
  await page.goBack()
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: channel,
      panel: null,
    })
  await expect(pane(page, thread)).toHaveCount(0)

  await page.goForward()
  await expect.poll(() => page.url()).toBe(threadUrl)
  await expect(pane(page, thread)).toHaveAttribute("data-front-panel", "true")
  await page.keyboard.press("ControlOrMeta+f")
  await expect(searchIn(page, thread)).toBeFocused()
  await page.keyboard.press("Escape")

  await page.reload()
  await expect(pane(page, thread).getByText("thread line 29")).toBeVisible({ timeout: 30_000 })
  await expect(scroller(page, channel)).toBeVisible()
  expect(page.url()).toBe(threadUrl)
  await expect(pane(page, thread)).toHaveAttribute("data-front-panel", "true")
  await page.keyboard.press("ControlOrMeta+f")
  await expect(searchIn(page, thread)).toBeFocused()
  await expect(searchIn(page, channel)).toHaveCount(0)
  await page.keyboard.press("Escape")

  // The channel named by the route is the pane a reload lands in.
  await workIn(page, channel)
  await expect.poll(() => streamIdOf(page)).toBe(channel)
  const channelUrl = page.url()
  await page.reload()
  await expect(pane(page, thread).getByText("thread line 29")).toBeVisible({ timeout: 30_000 })
  await expect(scroller(page, channel)).toBeVisible()
  expect(page.url()).toBe(channelUrl)
  await page.keyboard.press("ControlOrMeta+f")
  await expect(searchIn(page, channel)).toBeFocused()
  await expect(searchIn(page, thread)).toHaveCount(0)
})

/** A point inside `target`, as shares of its width and height. */
async function at(target: Locator, x: number, y: number) {
  const box = (await target.boundingBox())!
  return { x: box.x + box.width * x, y: box.y + box.height * y }
}

/** `at`, once `target` has stopped moving: a pane slides open. */
async function settledAt(target: Locator, x: number, y: number) {
  let last = ""
  await expect
    .poll(async () => {
      const box = JSON.stringify(await target.boundingBox())
      const still = box === last
      last = box
      return still
    })
    .toBe(true)
  return at(target, x, y)
}

async function drag(page: Page, source: Locator, to: { x: number; y: number }, hovering?: () => Promise<void>) {
  await source.scrollIntoViewIfNeeded()
  const from = await at(source, 0.5, 0.5)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  // Chromium coalesces emulated dragovers and can drop the last; a nudge lands one where the pointer rests.
  await page.mouse.move(to.x + 1, to.y)
  await page.mouse.move(to.x, to.y)
  await hovering?.()
  await page.mouse.up()
}

test("should keep both panes mounted when the first column's stream moves into another column and back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await loginAndCreateWorkspace(page, "pane-route-drag")
  const suffix = Date.now().toString(36)
  const names = { a: `route-a-${suffix}`, b: `route-b-${suffix}` }
  await createChannel(page, names.b)
  const streamB = streamIdOf(page)
  await createChannel(page, names.a)
  const streamA = streamIdOf(page)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  await post(page, workspaceId, streamA, "said in a")
  await post(page, workspaceId, streamB, "said in b")
  await page.reload()
  await expect(pane(page, streamA).getByText("said in a")).toBeVisible({ timeout: 30_000 })

  await drag(page, sidebarRow(page, names.b), await at(pane(page, streamA), 0.95, 0.4), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "right")
  })
  await expect(pane(page, streamB).getByText("said in b")).toBeVisible()
  // The stream dropped in is worked in, so the route names it.
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: streamB,
      panel: `${streamA}-${streamB}`,
    })
  await tag(scroller(page, streamA), "a")
  await tag(scroller(page, streamB), "b")

  // (d) A, the first column's stream, joins B's column as a tab.
  await drag(page, sidebarRow(page, names.a), await settledAt(pane(page, streamB), 0.5, 0.5), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "centre")
  })
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: streamA,
      panel: `${streamB}.${streamA}`,
    })
  await expect(page.getByTestId("main-pane")).toHaveCount(2)
  await expect(pane(page, streamA).getByText("said in a")).toBeVisible()
  expect({ a: await tagOf(scroller(page, streamA)), b: await tagOf(scroller(page, streamB)) }).toEqual({
    a: "a",
    b: "b",
  })

  // B's tab off the strip to the section's left edge: B is a first column of its own again, A beside it.
  await drag(page, tabLink(page, streamA, streamB), await at(pane(page, streamA), 0.05, 0.5), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "left")
  })
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: streamB,
      panel: streamA,
    })
  await expect(pane(page, streamB)).toHaveAttribute("data-testid", "main-pane")
  await expect(pane(page, streamA)).toHaveAttribute("data-testid", "panel")
  await expect(pane(page, streamA).getByText("said in a")).toBeVisible()
  await expect(pane(page, streamB).getByText("said in b")).toBeVisible()
  expect({ a: await tagOf(scroller(page, streamA)), b: await tagOf(scroller(page, streamB)) }).toEqual({
    a: "a",
    b: "b",
  })
})
