import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 120_000 })
// Headless Chromium hides scrollbars by default, and a hidden bar takes no width.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function rowSpan(row: Locator) {
  const box = (await row.boundingBox())!
  return { left: Math.round(box.x), right: Math.round(box.x + box.width) }
}

test("should keep a pane's rows in place when its content starts to scroll", async ({ page }) => {
  await loginAndCreateWorkspace(page, "gutter")
  await createChannel(page, `gutter-${Date.now().toString(36)}`)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamId = page.url().match(/\/s\/([^/?]+)/)![1]
  await post(page, workspaceId, streamId, "first")
  const timeline = page.locator('[data-editor-zone="main"]')
  const lastRow = timeline.locator("[data-message-id]").last()
  await expect(lastRow).toContainText("first", { timeout: 30_000 })
  const before = await rowSpan(lastRow)

  for (let i = 0; i < 30; i++) await post(page, workspaceId, streamId, `filler ${i}`)
  await expect(lastRow).toContainText("filler 29", { timeout: 30_000 })

  const scroller = page
    .locator("[data-message-id]")
    .first()
    .locator("xpath=ancestor::*[contains(@class,'overflow-y-auto')][1]")
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await rowSpan(lastRow)).toEqual(before)
})
