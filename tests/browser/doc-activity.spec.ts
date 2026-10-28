import { test, expect, type Page, type Locator } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"

/**
 * Edits to a doc land on its host's timeline as one activity row per quiet
 * window, naming who edited what, and arrive live over the socket.
 */

test.describe.configure({ timeout: 180_000 })

const pane = (page: Page, id: string): Locator => page.locator(`[data-panel-tab="${id}"]`)
const docEditor = (page: Page, docId: string): Locator => pane(page, docId).locator(".ProseMirror")
const activityRow = (page: Page, docId: string): Locator =>
  page.locator(`a[data-doc-id="${docId}"]`).filter({ hasText: "edited" })

async function createChannelViaApi(page: Page, workspaceId: string, slug: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug, visibility: "private" },
  })
  await expectApiOk(response, "Create channel")
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function createDoc(page: Page, workspaceId: string, hostId: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "doc", parentStreamId: hostId },
  })
  await expectApiOk(response, "Create doc")
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

test.describe("Doc activity rows", () => {
  test("should fold a burst of edits into one host-timeline row that appears live", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "doc-activity")
    const workspaceId = workspaceIdFromUrl(page)
    const channelId = await createChannelViaApi(page, workspaceId, `doc-activity-${testId}`)
    const docId = await createDoc(page, workspaceId, channelId)

    await page.goto(`/w/${workspaceId}/s/${channelId}`)
    await expect(page.locator(`[data-stream-scroller="${channelId}"]`)).toBeVisible({ timeout: 20000 })
    await page.locator(`a[data-doc-id="${docId}"]`).click()
    await expect(docEditor(page, docId)).toHaveAttribute("contenteditable", "true", { timeout: 15000 })

    await docEditor(page, docId).click()
    await page.keyboard.type("Rotation tracker for the spring release")
    await page.keyboard.press("Enter")
    await page.keyboard.type("AWS row owners")

    const row = activityRow(page, docId)
    await expect(row).toBeVisible({ timeout: 60000 })
    await expect(row).toContainText("Rotation tracker for the spring release")
    await expect(activityRow(page, docId)).toHaveCount(1)
  })
})
