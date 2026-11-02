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

/** Whether a read-write session made SQLite the primary copy of any database, durably. */
function sqlitePrimary(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open("threa-sqlite-primary")
        request.onupgradeneeded = () => request.transaction?.abort()
        request.onerror = () => resolve(false)
        request.onsuccess = () => {
          const markers = request.result
          const count = markers.transaction("primary").objectStore("primary").count()
          count.onsuccess = () => {
            markers.close()
            resolve(count.result > 0)
          }
        }
      })
  )
}

/** Whether the mirror's owner recorded SQLite as holding every mirrored store in full, which read-write needs. */
function mirrorHoldsEveryStore(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const unmirrored = new Set(["e2eDeviceKeys", "uploadJobs", "sqliteMarks"])
    for (const { name } of await indexedDB.databases()) {
      const hint = name ? localStorage.getItem(`threa:sqliteTrusted:${name}`) : null
      if (!name || !hint) continue
      const trusted = new Set((JSON.parse(hint) as { stores: string[] }).stores)
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const stores = [...database.objectStoreNames]
      database.close()
      return stores.every((store) => unmirrored.has(store) || trusted.has(store))
    }
    return false
  })
}

// Two reloads and four stream switches against a dev server; read-write also waits out a full copy.
test.describe.configure({ timeout: 180_000 })

for (const mode of ["shadow", "read-only", "read-write"] as const) {
  test(`keeps messages across stream switches and reloads with sqliteStorage=${mode}`, async ({ page }) => {
    const mirrorErrors: string[] = []
    page.on("console", (entry) => {
      if (entry.type() === "error" && entry.text().includes("SQLite")) mirrorErrors.push(entry.text())
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

    // Read-write starts on the boot after one that copied every store into SQLite.
    if (mode === "read-write") await expect.poll(() => mirrorHoldsEveryStore(page), { timeout: 90_000 }).toBe(true)

    // A boot that reads what the previous one mirrored.
    await page.reload()
    await expect(message(page, `hello first ${mode}`)).toBeVisible({ timeout: 20_000 })
    await switchTo(page, second.slug)
    await expect(message(page, `hello second ${mode}`)).toBeVisible()
    await send(page, `after reload ${mode}`)
    await switchTo(page, first.slug)
    await switchTo(page, second.slug)
    await expect(message(page, `after reload ${mode}`)).toBeVisible()
    expect(await sqlitePrimary(page)).toBe(mode === "read-write")

    expect(mirrorErrors).toEqual([])
  })
}
