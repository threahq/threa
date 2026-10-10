import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * "In this stream" is a pane of its own (`context:<streamId>[:<filter>]`)
 * beside the stream it lists: the stream stays usable, a jump scrolls it in
 * place with the overview still open, and a thread's overview opens to the
 * right of the thread and closes with it, on the board as on a stream. Where it
 * can't sit beside its stream (a phone) it is a bottom drawer over that stream.
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

async function seedChannelWithThread(page: Page, prefix: string, filler = 0) {
  await loginAndCreateWorkspace(page, prefix)
  await createChannel(page, `${prefix}-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()
  const anchorId = await postMessage(page, workspaceId!, streamId!, "channel link https://example.com/alpha")
  for (let i = 0; i < filler; i++) {
    await postMessage(page, workspaceId!, streamId!, `filler ${String(i).padStart(2, "0")} keeps the link off screen`)
  }
  const threadId = await createThread(page, workspaceId!, streamId!, anchorId)
  await postMessage(page, workspaceId!, threadId, "thread link https://example.org/beta")
  return { workspaceId: workspaceId!, streamId: streamId!, threadId, anchorId }
}

const overview = (page: Page) => page.getByRole("region", { name: "In this stream" })
const drawer = (page: Page) => page.getByRole("dialog", { name: "In this stream" })
const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")

async function box(page: Page, selector: string) {
  const rect = await page.locator(selector).first().boundingBox()
  if (!rect) throw new Error(`no box for ${selector}`)
  return rect
}

test("should open beside the stream and jump in place with the pane still open", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId, anchorId } = await seedChannelWithThread(page, "context-pane", 40)
  await page.goto(`/w/${workspaceId}/s/${streamId}`)

  await page.locator("header").getByRole("button", { name: "In this stream" }).click()
  await expect(overview(page).getByText("example.com").first()).toBeVisible()
  await expect.poll(() => panelParam(page)).toBe(`context:${streamId}`)
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // Beside, not over: the timeline ends where the pane begins, and the composer still takes a click.
  const main = await box(page, '[data-editor-zone="main"]')
  const pane = await overview(page).boundingBox()
  expect(main.x + main.width).toBeLessThanOrEqual(pane!.x + 1)
  const composer = page.locator('[data-editor-zone="main"] [contenteditable="true"]')
  await composer.click()
  await expect(composer).toBeFocused()

  const linkRow = page.locator(`[data-editor-zone="main"] [data-event-id][data-message-id="${anchorId}"]`)
  await expect(linkRow).not.toBeInViewport()
  await overview(page).getByRole("button", { name: "Go to message" }).last().click()
  await expect(linkRow).toBeInViewport()
  await expect(overview(page)).toBeVisible()

  // The root lists its threads' artifacts too; jumping to one opens the thread at the message.
  const threadRow = overview(page).locator("div.group", { hasText: "example.org" }).first()
  await threadRow.hover()
  await threadRow.getByRole("button", { name: "Go to message", exact: true }).click()
  await expect(tabPane(page, threadId).getByText("thread link")).toBeInViewport()
  expect(panelParam(page)).toContain(threadId)
})

test("should open a thread's overview beside the thread and close it with the thread", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId } = await seedChannelWithThread(page, "context-thread")
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)

  await tabPane(page, threadId).getByRole("button", { name: "In this stream" }).click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${threadId}-context:${threadId}`)
  await expect(overview(page).getByText("example.org", { exact: true })).toBeVisible()
  // Exact: the pane's tab title is the thread's name, which quotes the channel's link.
  await expect(overview(page).getByText("example.com", { exact: true })).toHaveCount(0)
  const thread = await tabPane(page, threadId).boundingBox()
  const pane = await overview(page).boundingBox()
  expect(thread!.x + thread!.width).toBeLessThanOrEqual(pane!.x + 1)

  // A filter is part of the pane's id, so it survives a reload.
  await overview(page)
    .getByRole("button", { name: /^Links/ })
    .click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${threadId}-context:${threadId}:link`)
  await page.reload()
  await expect(overview(page).getByRole("button", { name: /^Links/ })).toHaveAttribute("aria-pressed", "true", {
    timeout: 30_000,
  })

  await tabPane(page, threadId).getByRole("button", { name: "Close tab" }).first().click()
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(overview(page)).toHaveCount(0)
})

test("phone: the overview is a drawer over the stream; a jump closes it and Back brings it back", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, anchorId } = await seedChannelWithThread(page, "context-phone", 40)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await page.locator("header").getByRole("button", { name: "Stream actions" }).click()
  await page.getByRole("button", { name: /In this stream/ }).click()
  await expect(drawer(page).getByText("example.com").first()).toBeVisible()
  await expect.poll(() => panelParam(page)).toBe(`context:${streamId}`)
  // A drawer, not a page: the stream stays on show under it, and the drawer has no page header of its own.
  await expect(page.locator('[data-editor-zone="main"]')).toBeVisible()
  await expect(drawer(page).getByRole("button", { name: "Back" })).toHaveCount(0)

  await drawer(page).getByRole("button", { name: "Go to message" }).last().click()
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.locator(`[data-event-id][data-message-id="${anchorId}"]`)).toBeInViewport()

  await page.goBack()
  await expect(drawer(page).getByText("example.com").first()).toBeVisible()

  // Dismissing it pops its entry, so Back leaves the stream rather than reopening it.
  await page.keyboard.press("Escape")
  await expect(drawer(page)).toHaveCount(0)
  await expect.poll(() => panelParam(page)).toBeNull()
})

test("phone: a thread's overview is a drawer over the thread, and closing it leaves the thread", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId } = await seedChannelWithThread(page, "context-phone-thread")

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}.context:${threadId}`)
  await expect(drawer(page).getByText("example.org", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(tabPane(page, threadId).getByText("thread link")).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(drawer(page)).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/w/${workspaceId}/s/${threadId}`)
  expect(panelParam(page)).toBe(`${streamId}-${threadId}`)
  await expect(tabPane(page, threadId).getByText("thread link")).toBeVisible()
})

test("phone: the main view's overview opened last is a drawer over the main view, not under a thread", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId } = await seedChannelWithThread(page, "context-phone-main")

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}.context:${streamId}*`)
  await expect(drawer(page).getByText("example.com").first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-editor-zone="main"]')).toBeVisible()
  await expect(tabPane(page, threadId)).not.toBeVisible()
})

test("board: the overview opens as a pane beside the thread panel", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, threadId } = await seedChannelWithThread(page, "context-board")
  await page.goto(`/w/${workspaceId}/board?lens=all&panel=${threadId}`)

  await tabPane(page, threadId).getByRole("button", { name: "In this stream", exact: true }).click()
  await expect.poll(() => panelParam(page)).toBe(`${threadId}-context:${threadId}`)
  await expect(overview(page).getByText("example.org", { exact: true })).toBeVisible()
  await expect(drawer(page)).toHaveCount(0)
  const thread = await box(page, `[data-panel-tab="${threadId}"]`)
  const pane = await box(page, `[data-panel-tab="context:${threadId}"]`)
  expect(thread.x + thread.width).toBeLessThanOrEqual(pane.x + 1)

  await page.goBack()
  await expect.poll(() => panelParam(page)).toBe(threadId)
  await expect(overview(page)).toHaveCount(0)
  await expect(tabPane(page, threadId).getByText("thread link").first()).toBeVisible()
})

test("should show the toggle off while the overview is folded behind its thread", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId } = await seedChannelWithThread(page, "context-fold")
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}-context:${threadId}`)
  await expect(overview(page).getByText("example.org", { exact: true })).toBeVisible({ timeout: 30_000 })

  // Too narrow for two columns, the two fold into one section, the thread worked in on show.
  await tabPane(page, threadId).getByText("thread link").click()
  await page.setViewportSize({ width: 1000, height: 900 })
  await expect(tabPane(page, threadId).getByRole("button", { name: "1 more tab" })).toBeVisible()
  const toggle = tabPane(page, threadId).getByRole("button", { name: "In this stream" })
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await expect(overview(page)).not.toBeInViewport()

  // Bringing it forward changes nothing in the URL, so it is no step in history either.
  const entries = await page.evaluate(() => history.length)
  const url = page.url()
  await toggle.click()
  await expect(overview(page)).toBeInViewport()
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => history.length)).toBe(entries)
})

test("should offer the overview from an archived channel's mobile sheet", async ({ page }) => {
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
  await expect(overview(page).getByText("example.com").first()).toBeVisible()
})

test("should offer the overview from an archived thread's mobile panel sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId } = await seedChannelWithThread(page, "context-archived-thread")
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/streams/${threadId}/archive`),
    "archive thread"
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)
  await page.locator("header", { hasText: "Back" }).getByRole("button", { name: "Stream actions" }).click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /In this stream/ })
    .click()
  await expect(overview(page).getByText("example.org").first()).toBeVisible()
})
