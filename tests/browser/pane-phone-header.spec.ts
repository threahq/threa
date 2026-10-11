import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * A phone shows one pane at a time: the route's stream, or the pane over it. Each
 * pane's own 48px header carries the sidebar toggle, and a pane over the route's
 * stream a Back chevron that closes it. There are no tabs to switch between.
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
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const routeStream = (page: Page) => new URL(page.url()).pathname.match(/\/s\/([^/]+)/)![1]

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
  test("should lay out a pane's header with the sidebar toggle, Back and actions, and no tabs", async ({ page }) => {
    const { workspaceId, streamId, threadA } = await seedTwoThreads(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}`)
    await expect(pane(page, threadA).getByText("reply in thread A")).toBeVisible({ timeout: 30_000 })

    const header = headerOf(page, threadA)
    expect((await header.boundingBox())!.height).toBe(48)
    await expect(header.getByRole("button", { name: "Pin sidebar" })).toBeVisible()
    await expect(header.getByRole("button", { name: "Back" })).toBeVisible()
    await expect(header.getByRole("button", { name: "Stream actions" })).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)

    await header.getByRole("button", { name: "Back" }).click()
    await expect(pane(page, streamId).getByText("second parent")).toBeVisible()
    const main = headerOf(page, streamId)
    expect((await main.boundingBox())!.height).toBe(48)
    await expect(main.getByRole("button", { name: "Pin sidebar" })).toBeVisible()
    await expect(main.getByRole("button", { name: "Back" })).toHaveCount(0)
  })

  test("should show the newest pane of a link written with several, and close down to the route's stream", async ({
    page,
  }) => {
    const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
    await expect(pane(page, threadB).getByText("reply in thread B")).toBeVisible({ timeout: 30_000 })
    await expect(pane(page, threadA).getByText("reply in thread A")).not.toBeVisible()

    await headerOf(page, threadB).getByRole("button", { name: "Back" }).click()
    await expect(pane(page, threadA).getByText("reply in thread A")).toBeVisible()
    await expect(pane(page, threadB)).toHaveCount(0)

    await headerOf(page, threadA).getByRole("button", { name: "Back" }).click()
    await expect(pane(page, streamId).getByText("second parent")).toBeVisible()
    expect({ stream: routeStream(page), panel: panelParam(page) }).toEqual({ stream: streamId, panel: null })
  })

  test("should open the sidebar on a right swipe along a pane's header, the pane staying on show", async ({ page }) => {
    const { workspaceId, streamId, threadA } = await seedTwoThreads(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}`)
    await expect(pane(page, threadA).getByText("reply in thread A")).toBeVisible({ timeout: 30_000 })

    await swipe(page, headerSelector(threadA), 120)
    await expect(
      page.getByRole("navigation", { name: "Sidebar navigation" }).getByRole("button", { name: "Collapse sidebar" })
    ).toBeVisible()
    expect({ stream: routeStream(page), panel: panelParam(page) }).toEqual({ stream: streamId, panel: threadA })
  })

  test("should give a compose pane the same header, closing back to its thread", async ({ page }) => {
    const { workspaceId, streamId, threadA } = await seedTwoThreads(page)
    const compose = `compose:${threadA}`
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${compose}`)
    await expect(pane(page, compose).getByRole("textbox", { name: "Expanded message editor" })).toBeVisible({
      timeout: 30_000,
    })

    const header = headerOf(page, compose)
    await expect(header.getByRole("button", { name: "Pin sidebar" })).toBeVisible()
    await header.getByRole("button", { name: "Back" }).click()
    await expect(pane(page, threadA).getByText("reply in thread A")).toBeVisible()
    expect(panelParam(page)).toBe(threadA)
  })

  test("should open the stream's actions sheet from the three dots", async ({ page }) => {
    const { workspaceId, streamId, threadA } = await seedTwoThreads(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}`)
    await expect(pane(page, threadA).getByText("reply in thread A")).toBeVisible({ timeout: 30_000 })

    await headerOf(page, threadA).getByRole("button", { name: "Stream actions" }).click()
    await expect(page.getByRole("dialog", { name: "Stream details and actions" })).toBeVisible()
  })

  test("should keep the title readable at 360px beside the chevron and the actions", async ({ page }) => {
    const { workspaceId, streamId, threadA } = await seedTwoThreads(page)
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}`)
    await expect(pane(page, threadA).getByText("reply in thread A")).toBeVisible({ timeout: 30_000 })

    const header = headerOf(page, threadA)
    const title = (await header.getByRole("navigation", { name: "breadcrumb" }).boundingBox())!
    const back = (await header.getByRole("button", { name: "Back" }).boundingBox())!
    const right = await Promise.all(
      ["Open an aside", "Search in conversation", "Stream actions"].map((name) =>
        header.getByRole("button", { name }).boundingBox()
      )
    )
    const leftmost = Math.min(...right.map((box) => box!.x))
    expect(title.x).toBeGreaterThanOrEqual(back.x + back.width)
    expect(title.x + title.width).toBeLessThanOrEqual(leftmost)
    expect(title.width).toBeGreaterThanOrEqual(100)
  })
})
