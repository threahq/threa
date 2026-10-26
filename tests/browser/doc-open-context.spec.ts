import { test, expect, type Page, type Locator } from "@playwright/test"
import {
  loginAndCreateWorkspace,
  workspaceIdFromUrl,
  createChannelViaApi,
  createDocViaApi,
  userIdByEmail,
} from "./helpers"
import { runTestSql } from "./global-setup"

/**
 * The doc open in a pane rides the heartbeat's device report, so an agent can
 * tell which doc "the doc" means. Closing the pane takes it out again.
 */

test.describe.configure({ timeout: 90_000 })

const pane = (page: Page, id: string): Locator => page.locator(`[data-panel-tab="${id}"]`)
const anchorRow = (page: Page, docId: string): Locator => page.locator(`a[data-doc-id="${docId}"]`)

/** The stored open-doc list in psql's array text form (`{a,b}`), or "" when no device is stored. */
function storedOpenDocIds(workspaceId: string, userId: string): string {
  return runTestSql(
    `SELECT open_doc_ids::text FROM user_device_contexts WHERE workspace_id = '${workspaceId}' AND user_id = '${userId}'`
  )
}

test.describe("Open doc in device context", () => {
  test("should report the doc open in a pane and drop it when the pane closes", async ({ page }) => {
    const { testId, email } = await loginAndCreateWorkspace(page, "doc-open-context")
    const workspaceId = workspaceIdFromUrl(page)
    const channelId = await createChannelViaApi(page, workspaceId, `open-docs-${testId}`)
    const docId = await createDocViaApi(page, workspaceId, channelId)
    const userId = await userIdByEmail(page, workspaceId, email)

    await page.goto(`/w/${workspaceId}/s/${channelId}`)
    await expect(page.locator(`[data-stream-scroller="${channelId}"]`)).toBeVisible({ timeout: 20000 })

    await anchorRow(page, docId).click()
    await expect(pane(page, docId).locator(".ProseMirror")).toBeAttached({ timeout: 15000 })
    await expect
      .poll(() => storedOpenDocIds(workspaceId, userId), {
        timeout: 15000,
        message: "the open doc should reach the stored device report",
      })
      .toBe(`{${docId}}`)

    await pane(page, docId).getByRole("button", { name: "Close", exact: true }).click()
    await expect(pane(page, docId)).toHaveCount(0)
    await expect
      .poll(() => storedOpenDocIds(workspaceId, userId), {
        timeout: 15000,
        message: "closing the pane should clear the stored open docs",
      })
      .toBe("{}")
  })
})
