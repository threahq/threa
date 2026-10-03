import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * Desktop "In this stream" docks beside the stream it lists instead of covering
 * it: the stream stays usable, a jump scrolls it in place with the overview
 * still open, and a thread's overview docks to the right of the thread panel.
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
