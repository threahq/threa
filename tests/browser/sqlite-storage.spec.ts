import { test, expect, type Locator, type Page } from "@playwright/test"
import { createChannelViaApi, enrollUserFlag, loginAndCreateWorkspaceViaApi } from "./helpers"

const composer = (page: Page): Locator => page.locator("[data-editor-zone='main'] [contenteditable='true']")
const message = (page: Page, text: string): Locator =>
  page.getByRole("main").locator(".message-item").filter({ hasText: text })

async function send(page: Page, text: string) {
  const editor = composer(page)
  await editor.click()
  await editor.pressSequentially(text)
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
  await expect(message(page, text)).toBeVisible({ timeout: 10_000 })
}

/** The channel's composer takes focus once it is ready for input. */
async function opened(page: Page, slug: string) {
  await expect(page.getByRole("heading", { name: `#${slug}`, level: 1 })).toBeVisible({ timeout: 20_000 })
  await expect(composer(page)).toBeFocused({ timeout: 10_000 })
}

async function switchTo(page: Page, slug: string) {
  await page.getByRole("link", { name: `#${slug}` }).click()
  await opened(page, slug)
}

/** The OPFS pool directories the SQLite mirror worker created. */
function mirrorPools(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const names: string[] = []
    const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
      keys(): AsyncIterable<string>
    }
    for await (const name of root.keys()) if (name.startsWith(".threa-mirror-")) names.push(name)
    return names
  })
}

// Two reloads and four stream switches against a dev server.
test.describe.configure({ timeout: 120_000 })

for (const mode of ["shadow", "read-only"] as const) {
  test(`keeps messages across stream switches and reloads with sqliteStorage=${mode}`, async ({ page }) => {
    const mirrorErrors: string[] = []
    page.on("console", (entry) => {
      if (entry.type() === "error" && entry.text().includes("SQLite mirror")) mirrorErrors.push(entry.text())
    })
    const { workspaceId, testId } = await loginAndCreateWorkspaceViaApi(page, `sqlite-${mode}`)
    await enrollUserFlag(page, workspaceId, "sqliteStorage", mode)
    const first = { slug: `first-${testId}` }
    const second = { slug: `second-${testId}` }
    const firstId = await createChannelViaApi(page, workspaceId, first.slug)
    await createChannelViaApi(page, workspaceId, second.slug)

    await page.goto(`/w/${workspaceId}/s/${firstId}`)
    await opened(page, first.slug)
    // The mode takes effect on the boot after the flag arrives.
    await expect.poll(() => page.evaluate(() => localStorage.getItem("threa:sqliteStorage"))).toBe(mode)
    await page.reload()
    await opened(page, first.slug)
    await expect.poll(() => mirrorPools(page)).toHaveLength(1)

    await send(page, `hello first ${mode}`)
    await switchTo(page, second.slug)
    await send(page, `hello second ${mode}`)
    await switchTo(page, first.slug)
    await expect(message(page, `hello first ${mode}`)).toBeVisible()

    // A boot that reads what the previous one mirrored.
    await page.reload()
    await expect(message(page, `hello first ${mode}`)).toBeVisible({ timeout: 20_000 })
    await switchTo(page, second.slug)
    await expect(message(page, `hello second ${mode}`)).toBeVisible()
    await send(page, `after reload ${mode}`)
    await switchTo(page, first.slug)
    await switchTo(page, second.slug)
    await expect(message(page, `after reload ${mode}`)).toBeVisible()

    expect(mirrorErrors).toEqual([])
  })
}
