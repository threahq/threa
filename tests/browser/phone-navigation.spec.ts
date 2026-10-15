import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

/**
 * A phone has no tabs: it shows the route's stream or page, and at most one pane
 * over it. A thread opens over its stream, one step in history, and closes from
 * Back or its chevron. A sidebar pick or a link to another stream takes the route
 * there and drops the pane. A link to the message on show jumps to it again.
 */

test.describe.configure({ timeout: 120_000 })

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

const streamIdOf = (page: Page) => page.url().match(/\/s\/([^/?]+)/)![1]

async function channel(page: Page, workspaceId: string, slug: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", name: slug, slug, visibility: "public" },
  })
  await expectApiOk(response, `create ${slug}`)
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function seed(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "phone-nav")
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const names = { a: `nav-a-${testId}`, b: `nav-b-${testId}` }
  const streamB = await channel(page, workspaceId, names.b)
  const streamA = await channel(page, workspaceId, names.a)
  await post(page, workspaceId, streamB, "said in b")
  const parent = await post(page, workspaceId, streamA, "parent in a")
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamA, parentAnchorId: parent },
  })
  await expectApiOk(response, "create thread")
  const thread = ((await response.json()) as { stream: { id: string } }).stream.id
  await post(page, workspaceId, thread, "reply in a's thread")
  return { workspaceId, names, streamA, streamB, thread, parent }
}

const pane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const headerOf = (page: Page, id: string) => pane(page, id).locator("header").first()
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Sidebar navigation" })
const replyCard = (page: Page, streamId: string) => pane(page, streamId).getByRole("link", { name: /1 reply/ })

async function openSidebar(page: Page) {
  await page.evaluate(() => {
    const touch = (type: string, x: number) => {
      const point = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 500 })
      const touches = type === "touchend" ? [] : [point]
      document.body.dispatchEvent(
        new TouchEvent(type, { touches, changedTouches: [point], bubbles: true, cancelable: true })
      )
    }
    touch("touchstart", 40)
    touch("touchmove", 160)
    touch("touchmove", 320)
    touch("touchend", 320)
  })
  await expect(sidebar(page).getByLabel("Collapse sidebar")).toBeInViewport()
}

/**
 * Swipes the nearest scroller holding `inside` to its end. The touches make it a
 * reader's gesture: a bare `scrollTop` write is snapped back by a jump's refine loop.
 */
const swipeToEnd = (inside: Locator) =>
  inside.evaluate((element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight + 1 || getComputedStyle(node).overflowY === "visible") continue
      const touch = (type: string, y: number) => {
        const point = new Touch({ identifier: 1, target: node, clientX: 200, clientY: y })
        const touches = type === "touchend" ? [] : [point]
        node.dispatchEvent(new TouchEvent(type, { touches, changedTouches: [point], bubbles: true, cancelable: true }))
      }
      touch("touchstart", 600)
      touch("touchmove", 300)
      node.scrollTop = node.scrollHeight
      touch("touchend", 300)
      return
    }
  })

async function longPress(page: Page, selector: string) {
  const box = (await page.locator(selector).first().boundingBox())!
  const touch = { identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  await page.dispatchEvent(selector, "touchstart", {
    touches: [touch],
    changedTouches: [touch],
    targetTouches: [touch],
  })
  await page.waitForTimeout(700)
  await page.dispatchEvent(selector, "touchend", { touches: [], changedTouches: [], targetTouches: [] })
}

test("should open a thread over its stream, and close it from Back or its chevron", async ({ page }) => {
  const { workspaceId, streamA, thread } = await seed(page)
  await page.goto(`/w/${workspaceId}/s/${streamA}`)
  await expect(headerOf(page, streamA).getByRole("button", { name: "Pin sidebar" })).toBeVisible({ timeout: 30_000 })
  await expect(headerOf(page, streamA).getByRole("button", { name: "Back" })).toHaveCount(0)

  await replyCard(page, streamA).click()
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible({ timeout: 30_000 })
  await expect(headerOf(page, thread).getByRole("button", { name: "Pin sidebar" })).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({ stream: streamA, panel: thread })

  await page.goBack()
  await expect(pane(page, streamA).getByText("parent in a")).toBeVisible()
  await expect(pane(page, thread)).toHaveCount(0)
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({ stream: streamA, panel: null })

  await replyCard(page, streamA).click()
  await headerOf(page, thread).getByRole("button", { name: "Back" }).click()
  await expect(pane(page, streamA).getByText("parent in a")).toBeVisible()
  await expect(pane(page, thread)).toHaveCount(0)
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({ stream: streamA, panel: null })

  // A link that opens on the thread has no entry under it to pop, so its chevron closes in place.
  await page.goto(`/w/${workspaceId}/s/${streamA}?panel=${thread}`)
  await headerOf(page, thread).getByRole("button", { name: "Back" }).click({ timeout: 30_000 })
  await expect(pane(page, streamA).getByText("parent in a")).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({ stream: streamA, panel: null })
})

test("should jump to a message its link names, in the stream on show or by going to its stream", async ({ page }) => {
  const { workspaceId, streamA, streamB } = await seed(page)
  const origin = new URL(page.url()).origin
  const target = await post(page, workspaceId, streamA, "linked from a and b")
  for (let n = 1; n <= 30; n++) await post(page, workspaceId, streamA, `filler ${n}`)
  const link = `${origin}/w/${workspaceId}/s/${streamA}?m=${target}`
  await post(page, workspaceId, streamA, `same stream ${link}`)
  await post(page, workspaceId, streamB, `other stream ${link}`)
  const chipIn = (streamId: string) => pane(page, streamId).locator(`a[href="${link}"]`).first()
  const linked = pane(page, streamA).locator(`[data-message-id="${target}"]`).first()

  await page.goto(`/w/${workspaceId}/s/${streamA}`)
  await chipIn(streamA).click({ timeout: 30_000 })
  await expect(linked).toBeInViewport({ timeout: 30_000 })
  expect(new URL(page.url()).searchParams.get("m")).toBe(target)

  await swipeToEnd(linked)
  await expect(linked).not.toBeInViewport()
  await chipIn(streamA).click()
  await expect(linked).toBeInViewport({ timeout: 30_000 })

  await page.goto(`/w/${workspaceId}/s/${streamB}`)
  await chipIn(streamB).click({ timeout: 30_000 })
  await expect(linked).toBeInViewport({ timeout: 30_000 })
  await expect(pane(page, streamB)).toHaveCount(0)
  expect({ stream: streamIdOf(page), m: new URL(page.url()).searchParams.get("m"), panel: panelParam(page) }).toEqual({
    stream: streamA,
    m: target,
    panel: null,
  })
})

test("should take the route to a sidebar pick and drop the pane", async ({ page }) => {
  const { workspaceId, names, streamA, streamB, thread } = await seed(page)
  await page.goto(`/w/${workspaceId}/s/${streamA}?panel=${thread}`)
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible({ timeout: 30_000 })

  await openSidebar(page)
  await sidebar(page)
    .getByRole("link", { name: `#${names.b}` })
    .click()
  await expect(pane(page, streamB).getByText("said in b")).toBeVisible({ timeout: 30_000 })
  await expect(pane(page, thread)).toHaveCount(0)
  await expect(pane(page, streamA)).toHaveCount(0)
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({ stream: streamB, panel: null })

  await openSidebar(page)
  await sidebar(page).getByRole("link", { name: "Activity" }).click()
  await expect(pane(page, "page:activity")).toBeVisible({ timeout: 30_000 })
  await expect(pane(page, streamB)).toHaveCount(0)
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(`/w/${workspaceId}/activity`)

  await page.goBack()
  await expect(pane(page, streamB).getByText("said in b")).toBeVisible()
  await page.goBack()
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible()
})

test("should open a message's thread over its stream from the long-press menu", async ({ page }) => {
  const { workspaceId, streamA, thread, parent } = await seed(page)
  await page.goto(`/w/${workspaceId}/s/${streamA}`)
  const row = `[data-panel-tab="${streamA}"] [data-message-id="${parent}"] .message-content`
  await expect(page.locator(row)).toBeVisible({ timeout: 30_000 })

  await longPress(page, row)
  await page.getByRole("link", { name: "Reply in thread" }).click()
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible({ timeout: 30_000 })
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({ stream: streamA, panel: thread })
})

test("should flash the pane on show for a link to where the reader already is", async ({ page }) => {
  const { workspaceId, streamA } = await seed(page)
  const origin = new URL(page.url()).origin
  await post(page, workspaceId, streamA, `here ${origin}/w/${workspaceId}/s/${streamA}`)
  await page.goto(`/w/${workspaceId}/s/${streamA}`)
  const at = page.url()

  await pane(page, streamA).locator(`a[href$="/s/${streamA}"]`).first().click({ timeout: 30_000 })
  await expect(pane(page, streamA)).toHaveClass(/pane-flash/)
  await expect(pane(page, streamA)).not.toHaveClass(/pane-flash/)
  expect(page.url()).toBe(at)
})
