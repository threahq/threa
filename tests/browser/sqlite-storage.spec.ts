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

/** The storage mode recorded for each database; a database without a record runs off. */
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

/** The mode the delivered flag asked for the account's database; null while the page is between documents too. */
function requestedMode(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith("threa:sqliteStorage:"))
      return key ? localStorage.getItem(key) : null
    })
    .catch(() => null)
}

/** Counts the page's loads, so a test can wait out the reload a flag change triggers by itself. */
function countLoads(page: Page): () => number {
  let loads = 0
  page.on("load", () => loads++)
  return () => loads
}

/** Opens the channel and waits out the reload the delivered flag triggers, then the boot under its mode. */
async function openUnderFlag(page: Page, path: string, slug: string, mode: string) {
  const loads = countLoads(page)
  await page.goto(path)
  await expect.poll(() => requestedMode(page), { timeout: 30_000 }).toBe(mode)
  await expect.poll(loads, { timeout: 30_000 }).toBe(2)
  await opened(page, slug)
}

/** Read-write starts on the boot after one that copied every store into SQLite. */
async function enterReadWrite(page: Page, slug: string) {
  await expect.poll(() => mirrorHoldsEveryStore(page), { timeout: 90_000 }).toBe(true)
  await page.reload()
  await opened(page, slug)
  await expect.poll(() => recordedModes(page)).toEqual(["read-write"])
}

function sqliteErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (entry) => {
    if (entry.type() === "error" && entry.text().includes("SQLite")) errors.push(entry.text())
  })
  return errors
}

/** Whether the mirror's owner recorded SQLite as holding every mirrored store in full, which read-write needs. */
function mirrorHoldsEveryStore(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const unmirrored = (store: string) =>
      ["e2eDeviceKeys", "uploadJobs", "sqliteIncarnation"].includes(store) || store.startsWith("sqliteMarks:")
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
      return stores.every((store) => unmirrored(store) || trusted.has(store))
    }
    return false
  })
}

// Two reloads and four stream switches against a dev server; read-write also waits out a full copy.
test.describe.configure({ timeout: 180_000 })

for (const mode of ["shadow", "read-only", "read-write"] as const) {
  test(`keeps messages across stream switches and reloads with sqliteStorage=${mode}`, async ({ page }) => {
    const mirrorErrors = sqliteErrors(page)
    const { workspaceId, testId } = await loginAndCreateWorkspaceViaApi(page, `sqlite-${mode}`)
    await enrollUserFlag(page, workspaceId, "sqliteStorage", mode)
    const first = { slug: `first-${testId}` }
    const second = { slug: `second-${testId}` }
    const firstId = await createChannelViaApi(page, workspaceId, first.slug)
    await createChannelViaApi(page, workspaceId, second.slug)

    await openUnderFlag(page, `/w/${workspaceId}/s/${firstId}`, first.slug, mode)
    await expect.poll(() => mirrorPools(page)).toHaveLength(1)

    await send(page, `hello first ${mode}`)
    await switchTo(page, second.slug)
    await send(page, `hello second ${mode}`)
    await switchTo(page, first.slug)
    await expect(message(page, `hello first ${mode}`)).toBeVisible()

    if (mode === "read-write") await enterReadWrite(page, first.slug)

    // A boot that reads what the previous one mirrored.
    await page.reload()
    await expect(message(page, `hello first ${mode}`)).toBeVisible({ timeout: 20_000 })
    await switchTo(page, second.slug)
    await expect(message(page, `hello second ${mode}`)).toBeVisible()
    await send(page, `after reload ${mode}`)
    await switchTo(page, first.slug)
    await switchTo(page, second.slug)
    await expect(message(page, `after reload ${mode}`)).toBeVisible()
    expect(await recordedModes(page)).toEqual([mode])

    expect(mirrorErrors).toEqual([])
  })
}

test("turning read-write off with a second tab open reloads both and keeps every message", async ({ page }) => {
  const mirrorErrors = sqliteErrors(page)
  const { workspaceId, testId } = await loginAndCreateWorkspaceViaApi(page, "sqlite-flip")
  await enrollUserFlag(page, workspaceId, "sqliteStorage", "read-write")
  const first = { slug: `first-${testId}` }
  const second = { slug: `second-${testId}` }
  const firstId = await createChannelViaApi(page, workspaceId, first.slug)
  const secondId = await createChannelViaApi(page, workspaceId, second.slug)
  await openUnderFlag(page, `/w/${workspaceId}/s/${firstId}`, first.slug, "read-write")
  await enterReadWrite(page, first.slug)

  const other = await page.context().newPage()
  const otherErrors = sqliteErrors(other)
  await other.goto(`/w/${workspaceId}/s/${secondId}`)
  await opened(other, second.slug)
  await send(page, "from the first tab")
  await send(other, "from the second tab")
  // Seen from the other tab, each send committed: a reload aborts a transaction still in flight, as IndexedDB's does.
  await switchTo(page, second.slug)
  await expect(message(page, "from the second tab")).toBeVisible()
  await switchTo(other, first.slug)
  await expect(message(other, "from the first tab")).toBeVisible()

  const loads = [countLoads(page), countLoads(other)]
  await enrollUserFlag(page, workspaceId, "sqliteStorage", "off")
  for (const loaded of loads) await expect.poll(loaded, { timeout: 20_000 }).toBeGreaterThan(0)
  await expect.poll(() => requestedMode(page)).toBeNull()
  // The first boot holding the other tab out lands SQLite's backlog, then drops it.
  await expect.poll(() => recordedModes(page).catch(() => null), { timeout: 60_000 }).toEqual([])
  await expect.poll(() => mirrorPools(page).catch(() => null)).toEqual([])

  await opened(page, second.slug)
  await expect(message(page, "from the second tab")).toBeVisible()
  await switchTo(page, first.slug)
  await expect(message(page, "from the first tab")).toBeVisible()
  await opened(other, first.slug)
  await expect(message(other, "from the first tab")).toBeVisible()
  await switchTo(other, second.slug)
  await expect(message(other, "from the second tab")).toBeVisible()
  expect([...mirrorErrors, ...otherErrors]).toEqual([])
})
