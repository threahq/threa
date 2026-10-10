import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk } from "./helpers"

/**
 * Opening a second thread beside the first adds a tab to the panel, kept in
 * `?panel=` so reload and back land on the same arrangement. Tabs stack in one
 * grid cell: the ones behind stay mounted (expando tags survive a switch) and
 * live, but nothing judges them on screen.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function createThread(page: Page, workspaceId: string, streamId: string, parentId: string, reply: string) {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamId, parentAnchorId: parentId },
  })
  await expectApiOk(response, "create thread")
  const threadId = ((await response.json()) as { stream: { id: string } }).stream.id
  await post(page, workspaceId, threadId, reply)
  return threadId
}

async function seedTwoThreads(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "panel-tabs")
  await createChannel(page, `tabs-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const parentA = await post(page, workspaceId, streamId, "first parent")
  const parentB = await post(page, workspaceId, streamId, "second parent")
  const threadA = await createThread(page, workspaceId, streamId, parentA, "reply in thread A")
  const threadB = await createThread(page, workspaceId, streamId, parentB, "reply in thread B")
  await page.reload()
  await expect(page.getByRole("main").getByText("second parent")).toBeVisible({ timeout: 30_000 })
  return { testId, workspaceId, streamId, parentA, parentB, threadA, threadB }
}

const tabStrip = (page: Page) => page.getByRole("navigation", { name: "Panel tabs" }).first()
const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const replyIn = (page: Page, id: string, text: string) => tabPane(page, id).getByText(text)
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const route = (page: Page) => ({
  stream: new URL(page.url()).pathname.match(/\/s\/([^/]+)/)![1],
  panel: panelParam(page),
})

async function openFromTimeline(page: Page, parentId: string) {
  await page
    .locator(`[data-editor-zone="main"] [data-message-id="${parentId}"]`)
    .first()
    .getByRole("link", { name: /1 reply/i })
    .click()
}

async function tag(target: Locator, name: string) {
  await target.first().evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__tabTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.first().evaluate((el) => (el as unknown as Record<string, string>).__tabTag ?? null)
}

test("should open a second thread as a tab that switches, closes on back and survives reload", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { streamId, parentA, parentB, threadA, threadB } = await seedTwoThreads(page)

  // One thread reads as it always has: a title, no tab row.
  await openFromTimeline(page, parentA)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  await tag(replyIn(page, threadA, "reply in thread A"), "A")

  // The second opens beside it as a tab and takes the front, and the route with it.
  await openFromTimeline(page, parentB)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  expect(route(page)).toEqual({ stream: threadB, panel: `${streamId}-${threadA}.${threadB}` })
  // Unnamed threads take their parent message's text, so the tabs tell apart.
  await expect(tabStrip(page).getByRole("link")).toHaveText(["first parent", "second parent"])
  await expect(tabStrip(page).locator(`[aria-current="page"]`)).toHaveCount(1)
  await expect(replyIn(page, threadA, "reply in thread A")).not.toBeVisible()
  await tag(replyIn(page, threadB, "reply in thread B"), "B")

  // Switching brings A back without remounting either tab.
  await tabStrip(page).getByRole("link").first().click()
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(replyIn(page, threadB, "reply in thread B")).not.toBeVisible()
  expect(route(page)).toEqual({ stream: threadA, panel: `${streamId}-${threadA}*.${threadB}` })
  expect(await tagOf(replyIn(page, threadA, "reply in thread A"))).toBe("A")
  expect(await tagOf(replyIn(page, threadB, "reply in thread B"))).toBe("B")

  // The switch replaced its entry: back closes the tab B opened, A stays mounted. B opened from the
  // channel, which the click made the pane worked in.
  await page.goBack()
  await expect.poll(() => route(page)).toEqual({ stream: streamId, panel: threadA })
  await expect(tabPane(page, threadB)).toHaveCount(0)
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  expect(await tagOf(replyIn(page, threadA, "reply in thread A"))).toBe("A")

  // Forward and reload land on the same arrangement.
  await page.goForward()
  await expect.poll(() => route(page)).toEqual({ stream: threadA, panel: `${streamId}-${threadA}*.${threadB}` })
  await page.reload()
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible({ timeout: 30_000 })
  await expect(tabStrip(page).getByRole("link")).toHaveCount(2)
  await expect(replyIn(page, threadB, "reply in thread B")).not.toBeVisible()
})

test("should pop the history entry when closing the newest tab and replace when closing an older one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { streamId, parentA, parentB, threadA, threadB } = await seedTwoThreads(page)

  await openFromTimeline(page, parentA)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await openFromTimeline(page, parentB)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()

  // Closing B leaves exactly the entry before it opened, so back closes A next.
  await tabStrip(page).getByRole("button", { name: "Close tab" }).last().click()
  await expect.poll(() => route(page)).toEqual({ stream: streamId, panel: threadA })
  await page.goBack()
  await expect.poll(() => panelParam(page)).toBeNull()
  expect(new URL(page.url()).pathname).toContain(streamId)

  // Closing the older tab rewrites in place: back returns to A alone.
  await openFromTimeline(page, parentA)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await openFromTimeline(page, parentB)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  // Inactive tabs show their close on hover.
  await tabStrip(page).getByRole("link").first().hover()
  await tabStrip(page).getByRole("button", { name: "Close tab" }).first().click()
  await expect.poll(() => route(page)).toEqual({ stream: threadB, panel: `${streamId}-${threadB}` })
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  await page.goBack()
  await expect.poll(() => route(page)).toEqual({ stream: streamId, panel: threadA })
})

test("should leave a background tab unread until it comes to the front", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { testId, workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

  const other = await loginInNewContext(browser, `tabs-b-${testId}@example.com`, `Tabs B ${testId}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: `Tabs B ${testId}` },
    }),
    "second user joins workspace"
  )
  await expectApiOk(
    await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
    "second user joins the channel"
  )

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })

  const unread = async () => {
    const res = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
    await expectApiOk(res, "bootstrap")
    const body = (await res.json()) as { data: { unreadCounts: Record<string, number> } }
    return body.data.unreadCounts[threadA] ?? 0
  }

  await expect
    .poll(
      async () =>
        (
          await other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId: threadA, content: "news for the tab behind" },
          })
        ).status(),
      { timeout: 10_000 }
    )
    .toBe(201)

  // The tab behind is live: the message lands in its DOM, out of sight.
  await expect(replyIn(page, threadA, "news for the tab behind")).toBeAttached()
  await expect(replyIn(page, threadA, "news for the tab behind")).not.toBeVisible()
  await expect.poll(unread).toBeGreaterThan(0)
  // Long enough for an auto-read to have fired if anything judged it on screen.
  await page.waitForTimeout(2_000)
  expect(await unread()).toBeGreaterThan(0)
  // Reopened with the unread waiting, the tab behind lands on its new-messages
  // divider; Escape settles the stream on show, never that one.
  await page.reload()
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })
  await expect(replyIn(page, threadA, "news for the tab behind")).toBeAttached()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press("Escape")
  await page.waitForTimeout(1_000)
  expect(await unread()).toBeGreaterThan(0)

  await tabStrip(page).getByRole("link").first().click()
  await expect(replyIn(page, threadA, "news for the tab behind")).toBeVisible()
  await expect.poll(unread, { timeout: 15_000 }).toBe(0)

  await other.context.close()
})

test("should show one overview and hand keyboard focus to the tab brought forward", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })

  // The overview opens as one pane beside the tab it lists.
  await tabPane(page, threadB).getByRole("button", { name: "In this stream" }).click()
  await expect(page.getByRole("region", { name: "In this stream" })).toHaveCount(1)
  await expect.poll(() => panelParam(page)).toContain(`context:${threadB}`)

  // Panes mount in key order, so the overview's strip can come first in the DOM.
  await stripOf(page, threadB).getByRole("link").first().focus()
  await page.keyboard.press("Enter")
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(
    tabPane(page, threadA).getByRole("navigation", { name: "Panel tabs" }).locator('[aria-current="page"]')
  ).toBeFocused()
})

const stripOf = (page: Page, id: string) => tabPane(page, id).getByRole("navigation", { name: "Panel tabs" })

test("should split a tab beside its own and keep the split through back, forward, reload and a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { streamId, parentA, parentB, threadA, threadB } = await seedTwoThreads(page)

  await openFromTimeline(page, parentA)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await openFromTimeline(page, parentB)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  await tag(replyIn(page, threadA, "reply in thread A"), "A")
  await tag(replyIn(page, threadB, "reply in thread B"), "B")
  const tabbedWidth = (await tabPane(page, threadB).boundingBox())!.width

  await tabPane(page, threadB).getByRole("button", { name: "Stream actions" }).click()
  await page.getByRole("menuitem", { name: "Split right" }).click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${threadA}-${threadB}`)
  // Both show side by side without remounting, and the panel widens to hold them.
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  expect(await tagOf(replyIn(page, threadA, "reply in thread A"))).toBe("A")
  expect(await tagOf(replyIn(page, threadB, "reply in thread B"))).toBe("B")
  const [boxA, boxB] = await Promise.all([tabPane(page, threadA).boundingBox(), tabPane(page, threadB).boundingBox()])
  expect(boxA!.x + boxA!.width).toBeLessThanOrEqual(boxB!.x + 1)
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([tabPane(page, threadA).boundingBox(), tabPane(page, threadB).boundingBox()])
      return a!.width + b!.width
    })
    .toBeGreaterThan(tabbedWidth)

  // Each section is alone now, so each shows its own header; the tab split off is current until the other is used.
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  await expect.poll(() => route(page).stream).toBe(threadB)
  await replyIn(page, threadA, "reply in thread A").click()
  await expect.poll(() => route(page).stream).toBe(threadA)

  // The divider moves by drag and by keyboard.
  const divider = page.getByRole("separator", { name: "Resize panels side by side" })
  const valueOf = async () => Number(await divider.getAttribute("aria-valuenow"))
  // The panel's widening transition moves the divider too: start from where it settles.
  await expect
    .poll(async () => {
      const width = await valueOf()
      await page.waitForTimeout(250)
      return (await valueOf()) === width
    })
    .toBe(true)
  const beforeDrag = await valueOf()
  const grip = (await divider.boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => Math.abs((await valueOf()) - beforeDrag - 60)).toBeLessThanOrEqual(2)
  const before = await valueOf()
  await divider.focus()
  await page.keyboard.press("ArrowRight")
  await expect.poll(valueOf).toBe(before + 10)

  // The split replaced the entry B opened with: back returns to A alone.
  await page.goBack()
  await expect.poll(() => route(page)).toEqual({ stream: streamId, panel: threadA })
  await page.goForward()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${threadA}-${threadB}`)
  await page.reload()
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible({ timeout: 30_000 })
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  expect(route(page)).toEqual({ stream: threadA, panel: `${streamId}-${threadA}-${threadB}` })

  // Too narrow for two columns: they fold into one section's tabs, showing the pane worked in; the URL keeps the split.
  await page.setViewportSize({ width: 1000, height: 900 })
  await expect(stripOf(page, threadA).getByRole("link")).toHaveCount(2)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(replyIn(page, threadB, "reply in thread B")).not.toBeVisible()
  expect(panelParam(page)).toBe(`${streamId}-${threadA}-${threadB}`)
  // Using the main view leaves the folded section showing what it showed, not its last column.
  await page.locator('[data-editor-zone="main"]').getByText("second parent").click()
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(replyIn(page, threadB, "reply in thread B")).not.toBeVisible()
  expect(panelParam(page)).toBe(`${threadA}-${threadB}`)
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
})

test("should stack a tab split down under its own section", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}*.${threadB}`)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible({ timeout: 30_000 })
  // The tab behind loads while covered, so the split shows it without a wait.
  await expect(replyIn(page, threadB, "reply in thread B")).toBeAttached({ timeout: 30_000 })
  await tag(replyIn(page, threadA, "reply in thread A"), "A")
  await tag(replyIn(page, threadB, "reply in thread B"), "B")
  await tabPane(page, threadA).getByRole("button", { name: "Stream actions" }).click()
  await page.getByRole("menuitem", { name: "Split down" }).click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${threadB}--${threadA}`)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  // Neither tab remounts, so each keeps its scroll and draft.
  expect(await tagOf(replyIn(page, threadA, "reply in thread A"))).toBe("A")
  expect(await tagOf(replyIn(page, threadB, "reply in thread B"))).toBe("B")
  const [boxA, boxB] = await Promise.all([tabPane(page, threadA).boundingBox(), tabPane(page, threadB).boundingBox()])
  expect(boxB!.y + boxB!.height).toBeLessThanOrEqual(boxA!.y + 1)
  await expect(page.getByRole("separator", { name: "Resize stacked panels" })).toBeVisible()
})

test("should fold sections split down into tabs on a window too short for each", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 500 })
  const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

  // Nothing more fits down the column, so a split never offers it.
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}*.${threadB}`)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible({ timeout: 30_000 })
  await tabPane(page, threadA).getByRole("button", { name: "Stream actions" }).click()
  await expect(page.getByRole("menuitem", { name: "Split right" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Split down" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // An arrangement split down on a taller window shows its sections as tabs of one.
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${streamId}-${threadB}--${threadA}`)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible({ timeout: 30_000 })
  await expect(replyIn(page, threadB, "reply in thread B")).toBeHidden()
  await expect(page.getByRole("separator", { name: "Resize stacked panels" })).toHaveCount(0)
  const timeline = await tabPane(page, threadA).getByTestId("stream-timeline").boundingBox()
  expect(timeline!.height).toBeGreaterThanOrEqual(120)

  await page.setViewportSize({ width: 1400, height: 900 })
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  await expect(page.getByRole("separator", { name: "Resize stacked panels" })).toBeVisible()
  expect(panelParam(page)).toBe(`${streamId}-${threadB}--${threadA}`)
})

test("should close tabs beside one from its menu, and reopen them latest first", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)
  const parentC = await post(page, workspaceId, streamId, "third parent")
  const threadC = await createThread(page, workspaceId, streamId, parentC, "reply in thread C")

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}*.${threadC}`)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })
  await expect(tabStrip(page).getByRole("link")).toHaveText(["first parent", "second parent", "third parent"])
  // A stream pane's splits sit in its own menu, so its tab row carries no second one.
  await expect(tabPane(page, threadB).getByRole("button", { name: "Tab actions" })).toHaveCount(0)
  await tabPane(page, threadB).getByRole("button", { name: "Stream actions" }).click()
  await expect(page.getByRole("menuitem", { name: "Split right" })).toBeVisible()
  await page.keyboard.press("Escape")

  const middle = tabStrip(page).getByRole("link", { name: "second parent" })
  await middle.click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Close to the left" })).toBeEnabled()
  await page.getByRole("menuitem", { name: "Close to the right" }).click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${threadA}.${threadB}`)
  await expect(tabPane(page, threadC)).toHaveCount(0)

  await middle.click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: "Close to the right" })).toBeDisabled()
  await page.getByRole("menuitem", { name: "Close others" }).click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${threadB}`)
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)

  await page.keyboard.press("Alt+Shift+T")
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await page.keyboard.press("Alt+Shift+T")
  await expect(replyIn(page, threadC, "reply in thread C")).toBeVisible()
  await expect(tabStrip(page).getByRole("link")).toHaveCount(3)

  await middle.click({ button: "right" })
  await page.getByRole("menuitem", { name: "Close all" }).click()
  await expect.poll(() => panelParam(page)).toBeNull()
  await page.keyboard.press("Alt+Shift+T")
  await page.keyboard.press("Alt+Shift+T")
  await expect(tabStrip(page).getByRole("link")).toHaveCount(2)
  // A menu dismissed after Close all still hands focus back to its tab.
  const first = tabStrip(page).getByRole("link", { name: "first parent" })
  await first.click({ button: "right" })
  await page.keyboard.press("Escape")
  await expect(first).toBeFocused()
})

test("should even the panes along a divider when it is double-clicked", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)
  const boxOf = async (id: string) => (await tabPane(page, id).boundingBox())!
  const spread = (sizes: number[]) => Math.round(Math.max(...sizes) - Math.min(...sizes))
  const widths = async (...ids: string[]) => spread(await Promise.all(ids.map(async (id) => (await boxOf(id)).width)))
  const heights = async (...ids: string[]) => spread(await Promise.all(ids.map(async (id) => (await boxOf(id)).height)))
  const drag = async (divider: Locator, dx: number, dy: number) => {
    const grip = (await divider.boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2 + dx, grip.y + grip.height / 2 + dy, { steps: 5 })
    await page.mouse.up()
  }

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${streamId}-${threadA}-${threadB}`)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })
  const columns = page.getByRole("separator", { name: "Resize panels side by side" })
  await drag(columns, 80, 0)
  await expect.poll(() => widths(threadA, threadB)).toBeGreaterThan(100)
  await columns.dblclick()
  await expect.poll(() => widths(threadA, threadB)).toBeLessThanOrEqual(2)

  // The page's own divider evens every column, the page among them.
  const pageDivider = page.getByRole("separator", { name: "Resize thread panel" })
  await drag(pageDivider, 150, 0)
  await expect.poll(() => widths(streamId, threadA, threadB)).toBeGreaterThan(100)
  await pageDivider.dblclick()
  await expect.poll(() => widths(streamId, threadA, threadB)).toBeLessThanOrEqual(4)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${streamId}-${threadA}--${threadB}`)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })
  const rows = page.getByRole("separator", { name: "Resize stacked panels" })
  await drag(rows, 0, 120)
  await expect.poll(() => heights(threadA, threadB)).toBeGreaterThan(100)
  await rows.dblclick()
  await expect.poll(() => heights(threadA, threadB)).toBeLessThanOrEqual(2)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 400, height: 800 }, isMobile: true, hasTouch: true })

  test("should close the pane on show from the picker, and keep both mounted through a sheet switch", async ({
    page,
  }) => {
    const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
    await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })
    await tag(replyIn(page, threadB, "reply in thread B"), "B")
    await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)

    await tabPane(page, threadB).getByRole("button", { name: "3 open panes" }).click()
    await page
      .getByRole("dialog", { name: "Open panes" })
      .getByRole("link", { name: /first parent/ })
      .click()
    await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
    expect(await tagOf(replyIn(page, threadB, "reply in thread B"))).toBe("B")

    // Closing the pane on show from the picker keeps the other two open.
    await tabPane(page, threadA).getByRole("button", { name: "3 open panes" }).click()
    await page
      .getByRole("dialog", { name: "Open panes" })
      .getByRole("button", { name: /^Close .*first parent/ })
      .click()
    await expect(tabPane(page, threadA)).toHaveCount(0)
    await expect(tabPane(page, threadB).getByRole("button", { name: "2 open panes" })).toBeVisible()
    await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
    expect(await tagOf(replyIn(page, threadB, "reply in thread B"))).toBe("B")
  })

  test("should close every other pane from a row's menu in the open panes sheet", async ({ page }) => {
    const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
    await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })
    await tabPane(page, threadB).getByRole("button", { name: "3 open panes" }).click()
    const sheet = page.getByRole("dialog", { name: "Open panes" })
    await sheet.getByRole("link", { name: /first parent/ }).click({ button: "right" })
    await expect(page.getByRole("menuitem", { name: "Close above" })).toBeEnabled()
    await page.getByRole("menuitem", { name: "Close others" }).click()

    await expect(sheet).toHaveCount(0)
    await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
    await expect(tabPane(page, threadB)).toHaveCount(0)
    await expect(page.getByRole("button", { name: /open panes/ })).toHaveCount(0)
  })

  test("should show a split from a wider screen as panes of one stack and keep the URL", async ({ page }) => {
    const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}-${threadB}`)
    await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })
    await expect(replyIn(page, threadA, "reply in thread A")).not.toBeVisible()
    await expect(tabPane(page, threadB).getByRole("button", { name: "3 open panes" })).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
    expect(panelParam(page)).toBe(`${threadA}-${threadB}`)
  })
})
