import { test, expect } from "@playwright/test"
import {
  anchorRow,
  createChannelViaApi,
  createDocViaApi,
  docEditor,
  loginAndCreateWorkspace,
  openChannel,
  pane,
  workspaceIdFromUrl,
} from "./helpers"

/**
 * A doc's ⋯ menu browses the files embedded in it, like a channel's does, and a listed file links back to the
 * doc.
 */

test.describe.configure({ timeout: 150_000 })

// 1x1 red PNG
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000000030001" +
    "0005fed4ef0000000049454e44ae426082",
  "hex"
)

test("should browse a doc's embedded files from its menu and link a file back to the doc", async ({ page }) => {
  const { testId } = await loginAndCreateWorkspace(page, "doc-files")
  const workspaceId = workspaceIdFromUrl(page)
  const channelId = await createChannelViaApi(page, workspaceId, `doc-files-${testId}`, "private")
  const docId = await createDocViaApi(page, workspaceId, channelId)

  await openChannel(page, workspaceId, channelId)
  await anchorRow(page, docId).click()
  const docPane = pane(page, docId)
  await expect(docEditor(page, docId)).toHaveAttribute("contenteditable", "true", { timeout: 15000 })

  const filename = `diagram-${testId}.png`
  await docPane.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "image/png", buffer: PNG })
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`/api/workspaces/${workspaceId}/attachments/search`, {
          data: { streamIds: [docId] },
        })
        const body = (await response.json()) as { items: { filename: string }[] }
        return body.items.map((item) => item.filename)
      },
      { timeout: 20000, message: `the doc's saved body should embed ${filename}` }
    )
    .toEqual([filename])

  await docPane.getByRole("button", { name: "Stream actions" }).first().click()
  await page.getByRole("menuitem", { name: "Browse files…" }).click()

  const explorer = page.getByRole("dialog", { name: "Files" })
  await expect(explorer.getByRole("button", { name: new RegExp(filename) })).toBeVisible({ timeout: 15000 })
  expect(new URL(page.url()).searchParams.get("streams")).toBe(docId)

  const row = explorer.getByRole("button", { name: new RegExp(filename) })
  await row.hover()
  await row.locator(`a[href="/w/${workspaceId}/s/${docId}"]`).click()
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/s/${docId}$`))
  await expect(explorer).toBeHidden()
})
