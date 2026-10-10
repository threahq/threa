import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * A pane shows the tab row only when its own section holds two tabs; alone in
 * its section it keeps its own header, with the controls every pane has: a
 * focus toggle and a close at the trailing edge, and a title that drags while
 * there is another pane to drop it on.
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

async function seed(page: Page) {
  await loginAndCreateWorkspace(page, "one-chrome")
  await createChannel(page, `chrome-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const parentA = await post(page, workspaceId, streamId, "first parent")
  const parentB = await post(page, workspaceId, streamId, "second parent")
  const threadA = await createThread(page, workspaceId, streamId, parentA, "reply in thread A")
  const threadB = await createThread(page, workspaceId, streamId, parentB, "reply in thread B")
  await page.reload()
  await expect(page.getByRole("main").getByText("second parent")).toBeVisible({ timeout: 30_000 })
  return { streamId, parentA, parentB, threadA, threadB }
}

const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const mainPane = (page: Page) => page.getByTestId("main-pane")
const panelTabs = (page: Page) => page.getByRole("navigation", { name: "Panel tabs" })
const focusButton = (pane: Locator) => pane.getByRole("button", { name: "Focus pane", exact: true })
const closeButton = (pane: Locator) => pane.getByRole("button", { name: "Close", exact: true })

async function openFromTimeline(page: Page, parentId: string) {
  await page
    .locator(`[data-editor-zone="main"] [data-message-id="${parentId}"]`)
    .first()
    .getByRole("link", { name: /1 reply/i })
    .click()
}

async function at(target: Locator, x: number, y: number) {
  const box = (await target.boundingBox())!
  return { x: box.x + box.width * x, y: box.y + box.height * y }
}

async function drag(page: Page, source: Locator, to: { x: number; y: number }, hovering?: () => Promise<void>) {
  // Clear of the breadcrumb links at the title's start, which drag as themselves.
  const from = await at(source, 0.9, 0.5)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.move(to.x + 1, to.y)
  await page.mouse.move(to.x, to.y)
  await hovering?.()
  await page.mouse.up()
}

test("should give each pane of a stream and its thread its own header, controls and drag handle", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const { streamId, parentA, threadA } = await seed(page)
  await openFromTimeline(page, parentA)
  await expect(tabPane(page, threadA).getByText("reply in thread A")).toBeVisible()

  await expect(panelTabs(page)).toHaveCount(0)
  for (const pane of [mainPane(page), tabPane(page, threadA)]) {
    await expect(focusButton(pane)).toBeVisible()
    await expect(closeButton(pane)).toBeVisible()
    await expect(pane.locator("[data-pane-drag-handle]")).toHaveCount(1)
  }
  // The title of the pane not being worked in mutes, as a tab row's underline did.
  await expect(tabPane(page, threadA).locator("[data-pane-drag-handle]")).not.toHaveAttribute("data-pane-idle", "")
  await expect(mainPane(page).locator("[data-pane-drag-handle]")).toHaveAttribute("data-pane-idle", "")

  // Dropped on the stream's centre, the thread joins its section, which now needs the tab row.
  await drag(
    page,
    tabPane(page, threadA).locator("[data-pane-drag-handle]"),
    await at(mainPane(page), 0.5, 0.5),
    async () => {
      await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "centre")
    }
  )
  await expect
    .poll(() => new URL(page.url()).searchParams.get("panel"))
    .toMatch(new RegExp(`^${streamId}\\.${threadA}`))
  await expect(panelTabs(page)).toHaveCount(1)
  await expect(panelTabs(page).getByRole("link")).toHaveCount(2)
})

test("should show a lone stream page no focus toggle, no close and no drag handle", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await seed(page)

  await expect(panelTabs(page)).toHaveCount(0)
  await expect(focusButton(mainPane(page))).toHaveCount(0)
  await expect(closeButton(mainPane(page))).toHaveCount(0)
  await expect(page.locator("[data-pane-drag-handle]")).toHaveCount(0)
})

test("should end a tab's close button at the tab's trailing edge", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const { parentA, parentB, threadA, threadB } = await seed(page)
  await openFromTimeline(page, parentA)
  await expect(tabPane(page, threadA).getByText("reply in thread A")).toBeVisible()
  await openFromTimeline(page, parentB)
  await expect(tabPane(page, threadB).getByText("reply in thread B")).toBeVisible()

  const tabs = panelTabs(page).locator("[data-tab-id]")
  await expect(tabs).toHaveCount(2)
  for (const id of [threadA, threadB]) {
    const tab = panelTabs(page).locator(`[data-tab-id="${id}"]`)
    const [tabBox, closeBox] = await Promise.all([
      tab.boundingBox(),
      tab.getByRole("button", { name: "Close tab" }).boundingBox(),
    ])
    expect(tabBox!.x + tabBox!.width - (closeBox!.x + closeBox!.width)).toBeLessThanOrEqual(6)
  }
})
