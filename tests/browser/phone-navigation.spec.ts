import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

/**
 * On a phone a link shows what it names in place of the pane on show, one step in
 * history, and brings forward a pane already open instead. Tabs are opt in: only
 * "Open in new tab" adds one, and sidebar picks keep the tabs there are. Up goes
 * to the stream a pane was opened from. A link or pick to where the reader already is flashes the pane.
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
  const names = { a: `nav-a-${testId}`, b: `nav-b-${testId}`, c: `nav-c-${testId}` }
  const streamC = await channel(page, workspaceId, names.c)
  const streamB = await channel(page, workspaceId, names.b)
  const streamA = await channel(page, workspaceId, names.a)
  await post(page, workspaceId, streamB, "said in b")
  await post(page, workspaceId, streamC, "said in c")
  const parent = await post(page, workspaceId, streamA, "parent in a")
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamA, parentAnchorId: parent },
  })
  await expectApiOk(response, "create thread")
  const thread = ((await response.json()) as { stream: { id: string } }).stream.id
  await post(page, workspaceId, thread, "reply in a's thread")
  return { workspaceId, names, streamA, streamB, streamC, thread }
}

const pane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const headerOf = (page: Page, id: string) => pane(page, id).locator("header").first()
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const layers = (page: Page) => page.getByRole("button", { name: /^\d+ open panes$/ }).filter({ visible: true })
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

test("should show a thread in place of its stream, step Back to the stream, and go Up to it", async ({ page }) => {
  const { workspaceId, streamA, thread } = await seed(page)
  await page.goto(`/w/${workspaceId}/s/${streamA}`)
  await expect(headerOf(page, streamA).getByRole("button", { name: "Pin sidebar" })).toBeVisible({ timeout: 30_000 })
  await expect(headerOf(page, streamA).getByRole("button", { name: "Up" })).toHaveCount(0)

  await replyCard(page, streamA).click()
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible({ timeout: 30_000 })
  await expect(pane(page, streamA)).toHaveCount(0)
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({ stream: thread, panel: null })

  await page.goBack()
  await expect(pane(page, streamA).getByText("parent in a")).toBeVisible()
  await expect(pane(page, thread)).toHaveCount(0)

  await page.goto(`/w/${workspaceId}/s/${thread}`)
  await headerOf(page, thread).getByRole("button", { name: "Up" }).click()
  await expect(pane(page, streamA).getByText("parent in a")).toBeVisible({ timeout: 30_000 })
  await expect(pane(page, thread)).toHaveCount(0)
  await page.goBack()
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible()
})

test("should bring forward a thread already open from its card, without another tab", async ({ page }) => {
  const { workspaceId, streamA, thread } = await seed(page)
  await page.goto(`/w/${workspaceId}/s/${streamA}?panel=${thread}`)
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible({ timeout: 30_000 })
  await layers(page).click()
  await page.getByRole("dialog", { name: "Open panes" }).getByRole("link").first().click()
  await expect(pane(page, streamA).getByText("parent in a")).toBeVisible()

  await replyCard(page, streamA).click()
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible()
  await expect(layers(page)).toHaveAccessibleName("2 open panes")
  expect(panelParam(page)).toBe(`${streamA}-${thread}`)
})

test("should jump to a message its link names, in the stream on show or in place of it", async ({ page }) => {
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

  await page.goto(`/w/${workspaceId}/s/${streamB}`)
  await chipIn(streamB).click({ timeout: 30_000 })
  await expect(linked).toBeInViewport({ timeout: 30_000 })
  expect({ stream: streamIdOf(page), m: new URL(page.url()).searchParams.get("m") }).toEqual({
    stream: streamA,
    m: target,
  })
})

test("should keep the tabs through sidebar picks, and add one only from Open in new tab", async ({ page }) => {
  const { workspaceId, names, streamA, streamB, streamC, thread } = await seed(page)
  await page.goto(`/w/${workspaceId}/s/${streamA}?panel=${thread}`)
  await expect(pane(page, thread).getByText("reply in a's thread")).toBeVisible({ timeout: 30_000 })

  await openSidebar(page)
  await sidebar(page)
    .getByRole("link", { name: `#${names.b}` })
    .click()
  await expect(pane(page, streamB).getByText("said in b")).toBeVisible({ timeout: 30_000 })
  await expect(pane(page, thread)).toHaveCount(0)
  await expect(layers(page)).toHaveAccessibleName("2 open panes")
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({
    stream: streamB,
    panel: `${streamA}-${streamB}`,
  })

  await openSidebar(page)
  await longPress(page, `[aria-label="Sidebar navigation"] a[href$="/s/${streamC}"]`)
  await page.getByRole("button", { name: "Open in new tab" }).click()
  await expect(pane(page, streamC).getByText("said in c")).toBeVisible({ timeout: 30_000 })
  await expect(layers(page)).toHaveAccessibleName("3 open panes")
  await expect(pane(page, streamB)).toBeAttached()

  await openSidebar(page)
  await sidebar(page).getByRole("link", { name: "Activity" }).click()
  await expect(pane(page, "page:activity")).toBeVisible({ timeout: 30_000 })
  await expect(layers(page)).toHaveAccessibleName("3 open panes")
  await expect(pane(page, streamC)).toHaveCount(0)

  await page.goBack()
  await expect(pane(page, streamC).getByText("said in c")).toBeVisible()
})

test("should flash the pane on show for a link or pick to where the reader already is", async ({ page }) => {
  const { workspaceId, names, streamA } = await seed(page)
  const origin = new URL(page.url()).origin
  await post(page, workspaceId, streamA, `here ${origin}/w/${workspaceId}/s/${streamA}`)
  await page.goto(`/w/${workspaceId}/s/${streamA}`)
  const at = page.url()

  await pane(page, streamA).locator(`a[href$="/s/${streamA}"]`).first().click({ timeout: 30_000 })
  await expect(pane(page, streamA)).toHaveClass(/pane-flash/)
  await expect(pane(page, streamA)).not.toHaveClass(/pane-flash/)
  expect(page.url()).toBe(at)

  await openSidebar(page)
  await sidebar(page)
    .getByRole("link", { name: `#${names.a}` })
    .click()
  await expect(pane(page, streamA)).toHaveClass(/pane-flash/)
  expect(page.url()).toBe(at)
})
