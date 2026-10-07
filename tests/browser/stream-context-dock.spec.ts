import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * Desktop "In this stream" docks beside the stream it lists instead of covering
 * it: the stream stays usable, a jump scrolls it in place with the overview
 * still open, and a thread's overview docks to the right of the thread panel.
 * Where the column can't fit beside the main column it floats over the stream's
 * top-right corner instead.
 */

test.describe.configure({ timeout: 120_000 })

async function postMessage(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function createThread(page: Page, workspaceId: string, streamId: string, anchorMessageId: string) {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamId, parentAnchorId: anchorMessageId },
  })
  await expectApiOk(response, "create thread")
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

const dock = (page: Page) => page.getByRole("complementary", { name: "In this stream" })

async function box(page: Page, selector: string) {
  const rect = await page.locator(selector).first().boundingBox()
  if (!rect) throw new Error(`no box for ${selector}`)
  return rect
}

test("docks beside the stream, jumps in place, and docks a thread's overview beside the thread", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await loginAndCreateWorkspace(page, "context-dock")
  await createChannel(page, `dock-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()

  const linkMessageId = await postMessage(page, workspaceId!, streamId!, "channel link https://example.com/alpha")
  for (let i = 0; i < 40; i++) {
    await postMessage(page, workspaceId!, streamId!, `filler ${String(i).padStart(2, "0")} keeps the link off screen`)
  }
  const threadId = await createThread(page, workspaceId!, streamId!, linkMessageId)
  await postMessage(page, workspaceId!, threadId, "thread link https://example.org/beta")
  await page.reload()

  // Escape right after opening closes it, and focus goes back to the toggle.
  const toggle = page.getByRole("button", { name: "In this stream" })
  await toggle.click()
  await expect(dock(page)).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dock(page)).toHaveCount(0)
  await expect(toggle).toBeFocused()

  await toggle.click()
  await expect(dock(page).getByText("example.com").first()).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // Beside, not over: the timeline ends where the dock begins, and the
  // composer still takes a click.
  const main = await box(page, '[data-editor-zone="main"]')
  const docked = await box(page, '[data-testid="stream-context-dock"]')
  expect(main.x + main.width).toBeLessThanOrEqual(docked.x + 1)
  await page.locator('[data-editor-zone="main"] [contenteditable="true"]').click()

  const linkRow = page.locator(`[data-editor-zone="main"] [data-event-id][data-message-id="${linkMessageId}"]`)
  await expect(linkRow).not.toBeInViewport()
  await dock(page).getByRole("button", { name: "Go to message" }).last().click()
  await expect(linkRow).toBeInViewport()
  await expect(dock(page)).toBeVisible()
  expect(new URL(page.url()).searchParams.get("context")).not.toBeNull()

  // The root lists its threads' artifacts too; jumping to one opens the thread
  // at the message.
  const threadRow = dock(page).locator("div.group", { hasText: "example.org" }).first()
  await threadRow.hover()
  await threadRow.getByRole("button", { name: "Go to message", exact: true }).click()
  await expect(page.getByTestId("panel").getByText("thread link")).toBeInViewport()
  expect(new URL(page.url()).searchParams.get("panel")).toBe(threadId)

  // A thread's overview lists the thread alone and docks right of its panel.
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)
  await page.getByTestId("panel").getByRole("button", { name: "In this stream" }).click()
  await expect(dock(page).getByText("example.org").first()).toBeVisible()
  await expect(dock(page).getByText("example.com")).toHaveCount(0)
  const panel = await box(page, '[data-testid="panel"]')
  const threadDock = await box(page, '[data-testid="stream-context-dock"]')
  expect(panel.x + panel.width).toBeLessThanOrEqual(threadDock.x + 1)

  await dock(page)
    .getByPlaceholder(/Search this/)
    .click()
  await page.keyboard.press("Escape")
  await expect(dock(page)).toHaveCount(0)
  await expect(page.getByTestId("panel").getByText("thread link")).toBeVisible()
})

async function seedChannelWithThread(page: Page, prefix: string) {
  await loginAndCreateWorkspace(page, prefix)
  await createChannel(page, `${prefix}-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()
  const anchorId = await postMessage(page, workspaceId!, streamId!, "channel link https://example.com/alpha")
  const threadId = await createThread(page, workspaceId!, streamId!, anchorId)
  await postMessage(page, workspaceId!, threadId, "thread link https://example.org/beta")
  return { workspaceId: workspaceId!, streamId: streamId!, threadId }
}

test("floats over the thread where the dock can't fit beside it, and docks once there's room", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId } = await seedChannelWithThread(page, "context-narrow")

  // Beside the pinned sidebar, main (400) + thread (300) fit but a third
  // 300px column doesn't.
  await page.setViewportSize({ width: 1150, height: 900 })
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)
  const toggle = page.getByTestId("panel").getByRole("button", { name: "In this stream" })
  await toggle.click()
  await expect(dock(page)).toBeFocused()
  await expect(dock(page).getByText("example.org").first()).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByTestId("stream-context-dock").getByRole("complementary")).toHaveCount(0)

  // Over the thread's top-right corner, below its header, with main untouched.
  const floating = await dock(page).boundingBox()
  const panel = await box(page, '[data-testid="panel"]')
  const panelHeader = await box(page, '[data-testid="panel"] header')
  expect(floating!.x + floating!.width).toBeGreaterThan(panel.x + panel.width - 16)
  expect(floating!.y).toBeGreaterThanOrEqual(panelHeader.y + panelHeader.height)
  expect((await box(page, '[data-editor-zone="main"]')).width).toBeGreaterThanOrEqual(400)

  await page.keyboard.press("Escape")
  await expect(dock(page)).toHaveCount(0)
  await expect(toggle).toBeFocused()

  // Crossing the fit width moves the overview between float and dock without
  // pulling focus out of the composer.
  await toggle.click()
  await expect(dock(page)).toBeFocused()
  const composer = page.locator('[data-testid="panel"] [contenteditable="true"]')
  // The float covers the composer's right side; its left edge is what a reader can reach.
  await composer.click({ position: { x: 16, y: 8 } })
  await expect(composer).toBeFocused()
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(page.getByTestId("stream-context-dock").getByText("example.org").first()).toBeVisible()
  await expect(dock(page)).toHaveCount(1)
  await expect(composer).toBeFocused()
  await page.setViewportSize({ width: 1150, height: 900 })
  await expect(page.getByTestId("stream-context-dock").getByRole("complementary")).toHaveCount(0)
  await expect(dock(page).getByText("example.org").first()).toBeVisible()
  await expect(composer).toBeFocused()

  // The float covers the thread, so a jump closes it.
  const row = dock(page).locator("div.group", { hasText: "example.org" }).first()
  await row.hover()
  await row.getByRole("button", { name: "Go to message", exact: true }).click()
  await expect(dock(page)).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get("context")).toBeNull()
  await expect(page.getByTestId("panel").getByText("thread link")).toBeInViewport()
})

test("the floating overview steps aside for an aside sheet and returns when it closes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId } = await seedChannelWithThread(page, "context-stage")

  // Beside the pinned sidebar, a 900px window leaves no room for main + dock.
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await page.locator("header").getByRole("button", { name: "In this stream" }).click()
  await expect(dock(page).getByText("example.com").first()).toBeVisible()

  await page.getByTestId("aside-header-chip").click()
  await expect(page.getByTestId("aside-sheet")).toBeVisible({ timeout: 15000 })
  await expect(dock(page)).toHaveCount(0)
  expect(new URL(page.url()).searchParams.get("context")).not.toBeNull()

  await page.getByRole("button", { name: "Close aside" }).click()
  await expect(page.getByTestId("aside-sheet")).toHaveCount(0)
  await expect(dock(page).getByText("example.com").first()).toBeVisible()
})

test("offers the overview from an archived channel's mobile sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId } = await seedChannelWithThread(page, "context-archived")
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/archive`),
    "archive channel"
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await page.locator("header").getByRole("button", { name: "Stream actions" }).click()
  await page.getByRole("button", { name: /In this stream/ }).click()
  await expect(page.getByRole("dialog").getByText("example.com").first()).toBeVisible()
})

test("offers the overview from an archived thread's mobile panel sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId } = await seedChannelWithThread(page, "context-archived-thread")
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/streams/${threadId}/archive`),
    "archive thread"
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)
  await page.locator("header", { hasText: "Back" }).getByRole("button", { name: "Stream actions" }).click()
  const sheet = page.getByRole("dialog")
  await sheet.getByRole("button", { name: /In this stream/ }).click()
  await expect(page.getByRole("dialog").getByText("example.org").first()).toBeVisible()
})
