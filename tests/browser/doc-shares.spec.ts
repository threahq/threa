import { test, expect, type Browser, type Page, type Locator } from "@playwright/test"
import {
  createChannelViaApi,
  createDocViaApi,
  expectApiOk,
  loginAndCreateWorkspace,
  loginInNewContext,
  workspaceIdFromUrl,
} from "./helpers"

/**
 * A doc chip posted into another stream lets that stream's readers open the doc, read-only. Sending one that
 * exposes a private channel's doc asks first, like sharing a message.
 */

test.describe.configure({ timeout: 150_000 })

const pane = (page: Page, id: string): Locator => page.locator(`[data-panel-tab="${id}"]`)
const docEditor = (page: Page, docId: string): Locator => pane(page, docId).locator(".ProseMirror")
const anchorRow = (page: Page, docId: string): Locator => page.locator(`a[data-doc-id="${docId}"]`)
const docChip = (scope: Locator): Locator => scope.locator('[data-type="doc-chip"]')

async function joinWorkspace(browser: Browser, workspaceId: string, testId: string) {
  const name = `doc-share-reader ${testId}`
  const { context, page } = await loginInNewContext(browser, `doc-share-reader-${testId}@example.com`, name)
  await expectApiOk(
    await page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member", name } }),
    "Reader joins workspace"
  )
  return { context, page }
}

async function openChannel(page: Page, workspaceId: string, streamId: string): Promise<void> {
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await expect(page.locator(`[data-stream-scroller="${streamId}"]`)).toBeVisible({ timeout: 20000 })
}

test.describe("Doc shares", () => {
  test("should let a reader of the channel open a private channel's doc read-only when its chip is shared there", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const owner = await ownerContext.newPage()
    const { testId } = await loginAndCreateWorkspace(owner, "doc-share")
    const workspaceId = workspaceIdFromUrl(owner)
    const privateId = await createChannelViaApi(owner, workspaceId, `private-docs-${testId}`, "private")
    const publicId = await createChannelViaApi(owner, workspaceId, `public-share-${testId}`, "public")
    const docId = await createDocViaApi(owner, workspaceId, privateId)
    const title = `Plan ${testId}`
    await expectApiOk(
      await owner.request.patch(`/api/workspaces/${workspaceId}/streams/${docId}`, { data: { displayName: title } }),
      "Rename doc"
    )
    const reader = await joinWorkspace(browser, workspaceId, testId)

    try {
      await openChannel(owner, workspaceId, privateId)
      await anchorRow(owner, docId).click()
      const ownerEditor = docEditor(owner, docId)
      await expect(ownerEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
      await ownerEditor.click()
      await owner.keyboard.type("Only the private channel wrote this\n")
      await expect
        .poll(async () => {
          const response = await owner.request.get(`/api/workspaces/${workspaceId}/docs/${docId}/updates?after=0`)
          return response.ok() ? ((await response.json()) as { updates: unknown[] }).updates.length : 0
        })
        .toBeGreaterThan(0)

      expect((await reader.page.request.get(`/api/workspaces/${workspaceId}/docs/${docId}`)).ok()).toBe(false)

      // An empty channel has no scroller yet, so its composer marks it as open.
      await owner.goto(`/w/${workspaceId}/s/${publicId}`)
      const composer = pane(owner, publicId).locator("[contenteditable='true']").last()
      await expect(composer).toBeVisible({ timeout: 20000 })
      await composer.click()
      await owner.keyboard.type(`/doc Plan ${testId.slice(0, 4)}`)
      await owner
        .getByRole("listbox", { name: "Doc suggestions" })
        .getByRole("option")
        .filter({ hasText: title })
        .click()
      await expect(docChip(composer)).toContainText(title)
      await owner.keyboard.press("Enter")
      await owner.getByRole("button", { name: "Share anyway" }).click({ timeout: 15000 })
      const ownerScroller = owner.locator(`[data-stream-scroller="${publicId}"]`)
      await expect(docChip(ownerScroller).filter({ hasText: title })).toBeVisible({ timeout: 15000 })

      await openChannel(reader.page, workspaceId, publicId)
      const sharedChip = docChip(reader.page.locator(`[data-stream-scroller="${publicId}"]`)).filter({ hasText: title })
      await expect(sharedChip).toBeVisible({ timeout: 15000 })
      await sharedChip.click()
      const readerEditor = docEditor(reader.page, docId)
      await expect(readerEditor).toContainText("Only the private channel wrote this", { timeout: 15000 })
      await expect(readerEditor).toHaveAttribute("contenteditable", "false")
    } finally {
      await ownerContext.close()
      await reader.context.close()
    }
  })
})
