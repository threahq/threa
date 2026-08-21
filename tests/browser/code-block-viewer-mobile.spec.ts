import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The full-screen code viewer at phone width: open from a message's code block,
 * long lines pan in scroll mode and stop panning once wrapped, and the OS back
 * gesture closes the viewer without leaving the stream. Layout overflow and
 * history integration are the two things jsdom cannot answer.
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 800 }

const LONG_LINE = `const unbreakable = "${"abcdef0123456789".repeat(8)}"`
const CODE_MARKDOWN = ["```ts", LONG_LINE, "export function f() {", "  return unbreakable", "}", "```"].join("\n")

async function seedCodeBlock(page: Page, workspaceId: string, streamId: string): Promise<void> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, content: CODE_MARKDOWN },
  })
  await expectApiOk(response, "Send code block message")
}

test("a code block opens full screen, wraps on demand, and closes on back", async ({ page }) => {
  await loginAndCreateWorkspace(page, "code-viewer")
  await createChannel(page, `code-${Date.now().toString(36)}`)

  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()

  await seedCodeBlock(page, workspaceId!, streamId!)
  await page.setViewportSize(PHONE)
  await page.reload()
  const streamUrl = page.url()

  const block = page.locator("[data-wrap]").first()
  await expect(block).toBeVisible({ timeout: 30_000 })
  await block.getByRole("button", { name: "Open full screen" }).click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("TypeScript")
  await expect(dialog).toContainText("4 lines")
  const body = dialog.locator("[data-wrap]")
  await expect(body).toHaveAttribute("data-wrap", "scroll")
  await expect.poll(() => body.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

  await dialog.getByRole("button", { name: "Wrap lines" }).click()
  await expect(body).toHaveAttribute("data-wrap", "wrap")
  await expect.poll(() => body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  await page.goBack()
  await expect(dialog).toBeHidden()
  expect(page.url()).toBe(streamUrl)
})
