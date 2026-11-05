import { test, expect, type Locator, type Page } from "@playwright/test"
import { createChannelViaApi, loginAndCreateWorkspaceViaApi } from "./helpers"

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

/** The OPFS pool directories SQLite storage's worker created. */
function sqlitePools(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const names: string[] = []
    const root = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle & {
      keys(): AsyncIterable<string>
    }
    for await (const name of root.keys()) if (name.startsWith(".threa-mirror-")) names.push(name)
    return names
  })
}

/** The storage mode recorded for each database; a database without a record runs on IndexedDB. */
function recordedModes(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const request = indexedDB.open("threa-sqlite-mode")
        request.onupgradeneeded = () => request.transaction?.abort()
        request.onerror = () => resolve([])
        request.onsuccess = () => {
          const modes = request.result
          const all = modes.transaction("mode").objectStore("mode").getAll()
          all.onsuccess = () => {
            modes.close()
            resolve(all.result as string[])
          }
        }
      })
  )
}

/** Drafts IndexedDB holds for the account, read without the app. */
function draftsInIndexedDb(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const account = (await indexedDB.databases()).find((database) => database.name?.startsWith("threa_v2_"))
    if (!account?.name) return 0
    return new Promise<number>((resolve) => {
      const request = indexedDB.open(account.name!)
      request.onerror = () => resolve(0)
      request.onsuccess = () => {
        const idb = request.result
        if (!idb.objectStoreNames.contains("drafts")) {
          idb.close()
          return resolve(0)
        }
        const count = idb.transaction("drafts").objectStore("drafts").count()
        count.onsuccess = () => {
          idb.close()
          resolve(count.result)
        }
      }
    })
  })
}

function countLoads(page: Page): () => number {
  let loads = 0
  page.on("load", () => loads++)
  return () => loads
}

function sqliteErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (entry) => {
    if (entry.type() === "error" && entry.text().includes("SQLite")) errors.push(entry.text())
  })
  return errors
}

test.describe.configure({ timeout: 120_000 })

test("a fresh device runs on SQLite from its first boot and keeps messages across switches and reloads", async ({
  page,
}) => {
  const errors = sqliteErrors(page)
  const loads = countLoads(page)
  const { workspaceId, testId } = await loginAndCreateWorkspaceViaApi(page, "sqlite-fresh")
  const first = { slug: `first-${testId}` }
  const second = { slug: `second-${testId}` }
  const firstId = await createChannelViaApi(page, workspaceId, first.slug)
  await createChannelViaApi(page, workspaceId, second.slug)

  const loadsBefore = loads()
  await page.goto(`/w/${workspaceId}/s/${firstId}`)
  await opened(page, first.slug)
  await expect.poll(() => recordedModes(page)).toEqual(["read-write"])
  await expect.poll(() => sqlitePools(page)).toEqual([expect.stringMatching(/^\.threa-mirror-[0-9a-f]+$/)])

  await send(page, "hello first")
  await switchTo(page, second.slug)
  await send(page, "hello second")
  await switchTo(page, first.slug)
  await expect(message(page, "hello first")).toBeVisible()
  expect(loads() - loadsBefore).toBe(1)

  await page.reload()
  await expect(message(page, "hello first")).toBeVisible({ timeout: 20_000 })
  await switchTo(page, second.slug)
  await expect(message(page, "hello second")).toBeVisible()
  await send(page, "after reload")
  await switchTo(page, first.slug)
  await switchTo(page, second.slug)
  await expect(message(page, "after reload")).toBeVisible()
  expect({ loads: loads() - loadsBefore, errors }).toEqual({ loads: 2, errors: [] })
})

test("two tabs share one SQLite copy without either reloading", async ({ page }) => {
  const errors = sqliteErrors(page)
  const { workspaceId, testId } = await loginAndCreateWorkspaceViaApi(page, "sqlite-tabs")
  const first = { slug: `first-${testId}` }
  const second = { slug: `second-${testId}` }
  const firstId = await createChannelViaApi(page, workspaceId, first.slug)
  const secondId = await createChannelViaApi(page, workspaceId, second.slug)
  await page.goto(`/w/${workspaceId}/s/${firstId}`)
  await opened(page, first.slug)

  const other = await page.context().newPage()
  const otherErrors = sqliteErrors(other)
  const loads = [countLoads(page), countLoads(other)]
  await other.goto(`/w/${workspaceId}/s/${secondId}`)
  await opened(other, second.slug)
  await send(page, "from the first tab")
  await send(other, "from the second tab")
  await switchTo(page, second.slug)
  await expect(message(page, "from the second tab")).toBeVisible()
  await switchTo(other, first.slug)
  await expect(message(other, "from the first tab")).toBeVisible()

  // The owning tab closes; the other takes the file over and keeps serving.
  await page.close()
  await switchTo(other, second.slug)
  await send(other, "after the owner closed")
  await switchTo(other, first.slug)
  await expect(message(other, "from the first tab")).toBeVisible()
  await switchTo(other, second.slug)
  await expect(message(other, "after the owner closed")).toBeVisible()
  expect({ loads: loads.map((loaded) => loaded()), errors: [...errors, ...otherErrors] }).toEqual({
    loads: [0, 1],
    errors: [],
  })
})

test("a device on IndexedDB imports its unsent draft into SQLite at the next boot", async ({ page }) => {
  // Until the test allows it, the page cannot reach OPFS, so the app runs on IndexedDB as a browser without SQLite storage does.
  await page.addInitScript(() => {
    if (localStorage.getItem("test:allowSqlite")) return
    Object.defineProperty(StorageManager.prototype, "getDirectory", { value: undefined, configurable: true })
  })
  const errors = sqliteErrors(page)
  const { workspaceId, testId } = await loginAndCreateWorkspaceViaApi(page, "sqlite-import")
  const slug = `import-${testId}`
  const channelId = await createChannelViaApi(page, workspaceId, slug)
  await page.goto(`/w/${workspaceId}/s/${channelId}`)
  await opened(page, slug)
  await send(page, "sent on IndexedDB")
  await composer(page).pressSequentially("unsent on IndexedDB")
  await expect.poll(() => draftsInIndexedDb(page), { timeout: 10_000 }).toBeGreaterThan(0)
  expect(await recordedModes(page)).toEqual([])

  await page.evaluate(() => localStorage.setItem("test:allowSqlite", "1"))
  await page.reload()
  await opened(page, slug)
  await expect(composer(page)).toHaveText("unsent on IndexedDB")
  await expect(message(page, "sent on IndexedDB")).toBeVisible()
  await expect.poll(() => recordedModes(page)).toEqual(["read-write"])
  await expect.poll(() => draftsInIndexedDb(page)).toBe(0)
  expect(errors).toEqual([])
})
