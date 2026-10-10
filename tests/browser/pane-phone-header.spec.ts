import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * A phone shows one pane at a time. Each pane's own 48px header carries Up to the
 * stream the pane was opened from, else the sidebar toggle, a layers button that
 * opens a sheet of the open panes, and segments that mark the position; a swipe
 * along the header steps between panes. No pane remounts on the way.
 */

test.describe.configure({ timeout: 120_000 })

test.use({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true })

interface Point {
  x: number
  y: number
}

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
  await loginAndCreateWorkspace(page, "phone-header")
  await createChannel(page, `phone-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const parentA = await post(page, workspaceId, streamId, "first parent")
  const parentB = await post(page, workspaceId, streamId, "second parent")
  const threadA = await createThread(page, workspaceId, streamId, parentA, "reply in thread A")
  const threadB = await createThread(page, workspaceId, streamId, parentB, "reply in thread B")
  return { workspaceId, streamId, threadA, threadB }
}

const pane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const headerOf = (page: Page, id: string) => pane(page, id).locator("header").first()
const layersOf = (page: Page, id: string, count: number) =>
  headerOf(page, id).getByRole("button", { name: `${count} open panes` })
const segmentsOf = (page: Page, id: string) => headerOf(page, id).locator("[data-pane-segment]")
const sheet = (page: Page) => page.getByRole("dialog", { name: "Open panes" })
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const routeStream = (page: Page) => new URL(page.url()).pathname.match(/\/s\/([^/]+)/)![1]

async function tag(target: Locator, name: string) {
  await target.first().evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__paneTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.first().evaluate((el) => (el as unknown as Record<string, string>).__paneTag ?? null)
}

async function countPushes(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __pushes: number }
    w.__pushes = 0
  })
}

const pushes = (page: Page) => page.evaluate(() => (window as unknown as { __pushes: number }).__pushes)

async function swipe(page: Page, headerSelector: string, dx: number) {
  const box = (await page.locator(headerSelector).first().boundingBox())!
  const from: Point = { x: box.x + box.width / 2 - dx / 2, y: box.y + box.height / 2 }
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
      { selector: headerSelector, type, point }
    )
  await dispatch("touchstart", from)
  await dispatch("touchmove", { x: from.x + dx / 2, y: from.y })
  await page.waitForTimeout(30)
  await dispatch("touchmove", { x: from.x + dx, y: from.y })
  await dispatch("touchend", { x: from.x + dx, y: from.y })
}

const headerSelector = (id: string) => `[data-panel-tab="${id}"] header`

test.describe("phone pane header", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __pushes: number }
      w.__pushes = 0
      const original = history.pushState.bind(history)
      history.pushState = (...args) => {
        w.__pushes += 1
        return original(...args)
      }
    })
  })

  async function openThreeTagged(page: Page) {
    const seeded = await seedTwoThreads(page)
    const { workspaceId, streamId, threadA, threadB } = seeded
    const seedUrl = page.url()
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
    await expect(pane(page, threadB).getByText("reply in thread B")).toBeVisible({ timeout: 30_000 })
    await expect(pane(page, threadA).getByText("reply in thread A")).toBeAttached({ timeout: 30_000 })
    await expect(pane(page, streamId).getByText("second parent")).toBeAttached({ timeout: 30_000 })
    await tag(pane(page, streamId).getByText("second parent"), "main")
    await tag(pane(page, threadA).getByText("reply in thread A"), "A")
    await tag(pane(page, threadB).getByText("reply in thread B"), "B")
    return { ...seeded, seedUrl }
  }

  async function expectTags(
    page: Page,
    { streamId, threadA, threadB }: { streamId: string; threadA: string; threadB: string }
  ) {
    expect([
      await tagOf(pane(page, streamId).getByText("second parent")),
      await tagOf(pane(page, threadA).getByText("reply in thread A")),
      await tagOf(pane(page, threadB).getByText("reply in thread B")),
    ]).toEqual(["main", "A", "B"])
  }

  test("should lay out the newest pane's header with up, layers, segments and actions", async ({ page }) => {
    const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
    await expect(pane(page, threadB).getByText("reply in thread B")).toBeVisible({ timeout: 30_000 })

    const header = headerOf(page, threadB)
    expect((await header.boundingBox())!.height).toBe(48)
    await expect(header.getByRole("button", { name: "Up" })).toBeVisible()
    await expect(header.getByRole("button", { name: "Pin sidebar" })).toHaveCount(0)
    await expect(layersOf(page, threadB, 3)).toBeVisible()
    await expect(header.getByRole("button", { name: "Stream actions" })).toBeVisible()
    await expect(segmentsOf(page, threadB)).toHaveCount(3)
    await expect(segmentsOf(page, threadB).nth(2)).toHaveAttribute("data-pane-segment", "current")
    await expect(segmentsOf(page, threadB).nth(0)).not.toHaveAttribute("data-pane-segment", "current")
    await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  })

  test("should switch panes from the sheet by replacing the entry, without remounting any pane", async ({ page }) => {
    const seeded = await openThreeTagged(page)
    const { streamId, threadA, threadB } = seeded

    const lengthBeforeOpen = await page.evaluate(() => history.length)
    await layersOf(page, threadB, 3).click()
    await expect(sheet(page)).toBeVisible()
    await countPushes(page)
    const rows = sheet(page).getByRole("link")
    await expect(rows).toHaveCount(3)
    for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expect(rows.nth(2)).toHaveAttribute("aria-current", "page")
    const lengthWhileOpen = await page.evaluate(() => history.length)
    expect(lengthWhileOpen).toBeLessThanOrEqual(lengthBeforeOpen + 1)

    await rows.first().click()
    await expect(sheet(page)).toHaveCount(0)
    await expect(pane(page, streamId).getByText("second parent")).toBeVisible()
    await expect.poll(() => routeStream(page)).toBe(streamId)
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest("[data-panel-tab]")?.getAttribute("data-panel-tab"))
      )
      .toBe(streamId)
    await page.waitForTimeout(500)
    expect(await pushes(page)).toBe(0)
    expect(await page.evaluate(() => history.length)).toBe(lengthWhileOpen)
    await expectTags(page, seeded)
    await expect(headerOf(page, streamId).getByRole("button", { name: "Pin sidebar" })).toBeVisible()
    await expect(headerOf(page, streamId).getByRole("button", { name: "Up" })).toHaveCount(0)
    expect(panelParam(page)).toBe(`${streamId}-${threadA}.${threadB}`)

    await page.goBack()
    await expect.poll(() => page.url()).toBe(seeded.seedUrl)
  })

  test("should close the sheet on browser back without moving the page", async ({ page }) => {
    const seeded = await openThreeTagged(page)
    const { streamId, threadA, threadB } = seeded

    await layersOf(page, threadB, 3).click()
    await expect(sheet(page)).toBeVisible()
    const whileOpen = page.url()
    await countPushes(page)
    await page.goBack()
    await expect(sheet(page)).toHaveCount(0)
    expect(page.url()).toBe(whileOpen)
    await expect(pane(page, threadB).getByText("reply in thread B")).toBeVisible()
    await page.waitForTimeout(500)
    expect(await pushes(page)).toBe(0)
    expect(panelParam(page)).toBe(`${streamId}-${threadA}.${threadB}`)
    expect(routeStream(page)).toBe(threadB)
    await expectTags(page, seeded)
  })

  test("should close a pane from the sheet and leave it closed through Back", async ({ page }) => {
    const seeded = await openThreeTagged(page)
    const { streamId, threadA, threadB, seedUrl } = seeded

    await layersOf(page, threadB, 3).click()
    await expect(sheet(page)).toBeVisible()
    const row = sheet(page).locator("li").filter({ hasText: "first parent" })
    const close = row.getByRole("button", { name: /^Close/ })
    expect((await close.boundingBox())!.width).toBeGreaterThanOrEqual(44)
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await close.click()
    await expect(sheet(page)).toHaveCount(0)
    await expect.poll(() => panelParam(page)).toBe(`${streamId}-${threadB}`)
    await expect(layersOf(page, threadB, 2)).toBeVisible()
    await expect(pane(page, threadA)).toHaveCount(0)

    await page.goBack()
    await expect.poll(() => page.url()).toBe(seedUrl)
    await expect(pane(page, threadA)).toHaveCount(0)
  })

  test("should step through the panes with a header swipe and keep the header still", async ({ page }) => {
    const seeded = await openThreeTagged(page)
    const { workspaceId, streamId, threadA, threadB } = seeded

    const controls = (id: string) => [
      headerOf(page, id).getByRole("button", { name: "Up" }),
      headerOf(page, id).getByRole("navigation", { name: "breadcrumb" }),
      layersOf(page, id, 3),
      headerOf(page, id).getByRole("button", { name: "Stream actions" }),
    ]
    const boxes = async (locators: Locator[]) => Promise.all(locators.map((locator) => locator.boundingBox()))
    const boxesOfB = await boxes(controls(threadB))
    for (const box of boxesOfB) expect(box).not.toBeNull()
    await countPushes(page)
    await swipe(page, headerSelector(threadB), 120)
    await expect(pane(page, threadA).getByText("reply in thread A")).toBeVisible()
    await expect(segmentsOf(page, threadA).nth(1)).toHaveAttribute("data-pane-segment", "current")
    // The sidebar animates open, so its absence proves nothing until it would have finished.
    await page.waitForTimeout(300)
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveCount(0)

    await swipe(page, headerSelector(threadA), 120)
    await expect(pane(page, streamId).getByText("second parent")).toBeVisible()
    await expect(segmentsOf(page, streamId).nth(0)).toHaveAttribute("data-pane-segment", "current")
    await expect(headerOf(page, streamId).getByRole("button", { name: "Pin sidebar" })).toBeVisible()

    await page.reload()
    await expect(pane(page, streamId).getByText("second parent")).toBeVisible({ timeout: 30_000 })
    await expect(segmentsOf(page, streamId).nth(0)).toHaveAttribute("data-pane-segment", "current")
    await expect(pane(page, threadB).getByText("reply in thread B")).not.toBeVisible()
    expect(routeStream(page)).toBe(streamId)
    expect(panelParam(page)).toBe(`${streamId}-${threadA}*.${threadB}`)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
    await expect(pane(page, threadB).getByText("reply in thread B")).toBeVisible({ timeout: 30_000 })
    await tag(pane(page, streamId).getByText("second parent"), "main")
    await tag(pane(page, threadA).getByText("reply in thread A"), "A")
    await tag(pane(page, threadB).getByText("reply in thread B"), "B")

    const shows = (id: string, text: string) => expect(pane(page, id).getByText(text)).toBeVisible()
    await swipe(page, headerSelector(threadB), 120)
    await shows(threadA, "reply in thread A")
    await swipe(page, headerSelector(threadA), -120)
    await shows(threadB, "reply in thread B")
    await swipe(page, headerSelector(threadB), 120)
    await shows(threadA, "reply in thread A")
    await swipe(page, headerSelector(threadA), 120)
    await shows(streamId, "second parent")
    await swipe(page, headerSelector(streamId), -120)
    await shows(threadA, "reply in thread A")
    await swipe(page, headerSelector(threadA), -120)
    await shows(threadB, "reply in thread B")
    await swipe(page, headerSelector(threadB), -120)
    await page.waitForTimeout(300)
    await expect(pane(page, threadB).getByText("reply in thread B")).toBeVisible()
    await expect(segmentsOf(page, threadB).nth(2)).toHaveAttribute("data-pane-segment", "current")

    expect(await boxes(controls(threadB))).toEqual(boxesOfB)
    await expectTags(page, seeded)
  })

  test("should open the sidebar on a right swipe along the first pane's header", async ({ page }) => {
    const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${streamId}-${threadA}.${threadB}`)
    await expect(pane(page, streamId).getByText("second parent")).toBeVisible({ timeout: 30_000 })

    await swipe(page, headerSelector(streamId), 120)
    await expect(
      page.getByRole("navigation", { name: "Sidebar navigation" }).getByRole("button", { name: "Collapse sidebar" })
    ).toBeVisible()
  })

  test("should give a compose pane the same header: up, layers and segments", async ({ page }) => {
    const { workspaceId, streamId, threadA } = await seedTwoThreads(page)
    const compose = `compose:${threadA}`
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${compose}`)
    await expect(pane(page, compose).getByRole("textbox", { name: "Expanded message editor" })).toBeVisible({
      timeout: 30_000,
    })

    const header = headerOf(page, compose)
    await expect(header.getByRole("button", { name: "Up" })).toBeVisible()
    await expect(header.getByRole("button", { name: "Pin sidebar" })).toHaveCount(0)
    await expect(layersOf(page, compose, 3)).toBeVisible()
    await expect(segmentsOf(page, compose)).toHaveCount(3)
    await expect(segmentsOf(page, compose).nth(2)).toHaveAttribute("data-pane-segment", "current")
  })

  test("should open the stream's actions sheet from the three dots", async ({ page }) => {
    const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
    await expect(pane(page, threadB).getByText("reply in thread B")).toBeVisible({ timeout: 30_000 })

    await headerOf(page, threadB).getByRole("button", { name: "Stream actions" }).click()
    await expect(page.getByRole("dialog", { name: "Stream details and actions" })).toBeVisible()
  })

  test("should keep the title readable at 360px with three panes", async ({ page }) => {
    const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
    await expect(pane(page, threadB).getByText("reply in thread B")).toBeVisible({ timeout: 30_000 })

    const header = headerOf(page, threadB)
    const title = (await header.getByRole("navigation", { name: "breadcrumb" }).boundingBox())!
    const right = await Promise.all(
      ["Open an aside", "Search in conversation", "3 open panes", "Stream actions"].map((name) =>
        header.getByRole("button", { name }).boundingBox()
      )
    )
    const leftmost = Math.min(...right.map((box) => box!.x))
    expect(title.x + title.width).toBeLessThanOrEqual(leftmost)
    expect(title.width).toBeGreaterThanOrEqual(100)
  })
})
