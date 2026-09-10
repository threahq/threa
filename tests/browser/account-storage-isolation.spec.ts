import { test, expect, type Page } from "@playwright/test"
import { accountStorageKey, currentAccount, expectApiOk, loginAndCreateWorkspace } from "./helpers"
import { openAccountPicker, pickAccount, setUpSharedWorkspace, workspaceIdFrom } from "./account-fixtures"

/**
 * What a browser already holds when this ships, and what it holds afterwards.
 *
 * Before account-owned storage, a staged composer body was keyed by workspace
 * and scope alone and a cached database was named for whichever account the
 * pointer happened to name — neither is proof of who wrote it, because the build
 * that wrote them could resolve one account's identity while writing another
 * account's storage. Upgrading must therefore reveal none of it, replay none of
 * it to the server, and destroy none of it either: whose it is, is exactly what
 * is unknown.
 *
 * The second test is the other half — work created *after* the upgrade has a
 * known owner and has to survive leaving the account and coming back.
 */

test.describe.configure({ timeout: 240_000 })

const COMPOSER = "[data-editor-zone='main'] [contenteditable='true']"

/** Every draft the server holds for the signed-in account in this workspace. */
async function serverDraftBodies(page: Page, workspaceId: string): Promise<string> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/drafts`)
  await expectApiOk(response, "List drafts")
  return await response.text()
}

/** Seed a database under the pre-ownership name, with a workspace row an upgrade would surface. */
async function seedLegacyDatabase(page: Page, accountId: string, leakedName: string): Promise<void> {
  await page.evaluate(
    async ({ dbName, name }) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1)
        request.onupgradeneeded = () => {
          request.result.createObjectStore("workspaces", { keyPath: "id" })
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const tx = database.transaction("workspaces", "readwrite")
          tx.objectStore("workspaces").put({
            id: "workspace_from_an_unknown_account",
            name,
            slug: "leaked",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            _cachedAt: Date.now(),
          })
          tx.oncomplete = () => {
            database.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      })
    },
    { dbName: `threa_${accountId}`, name: leakedName }
  )
}

async function legacyDatabaseRowCount(page: Page, accountId: string): Promise<number> {
  return page.evaluate(async (dbName) => {
    return await new Promise<number>((resolve) => {
      const request = indexedDB.open(dbName)
      request.onerror = () => resolve(-1)
      request.onsuccess = () => {
        const database = request.result
        if (!database.objectStoreNames.contains("workspaces")) {
          database.close()
          resolve(-1)
          return
        }
        const count = database.transaction("workspaces", "readonly").objectStore("workspaces").count()
        count.onsuccess = () => {
          database.close()
          resolve(count.result)
        }
        count.onerror = () => {
          database.close()
          resolve(-1)
        }
      }
    })
  }, `threa_${accountId}`)
}

test.describe("Local state an upgrade inherits", () => {
  test("should never reveal or replay content whose owner is unknown, and never destroy it", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "legacy-upgrade")
    const workspaceId = workspaceIdFrom(page)
    const accountId = (await currentAccount(page)).id

    const stagedBody = `staged-by-nobody-${testId}`
    const leakedWorkspaceName = `LEAKED-WORKSPACE-${testId}`
    const legacyStagingKey = `threa:draft-stage:${workspaceId}:stream_legacy_${testId}`

    await page.evaluate(
      ({ key, text }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
            clientUpdatedAt: Date.now(),
          })
        )
      },
      { key: legacyStagingKey, text: stagedBody }
    )
    await seedLegacyDatabase(page, accountId, leakedWorkspaceName)

    // The upgrade: the app starts again over that storage and runs its startup
    // draft reconcile and its cache hydration.
    await page.goto(`/w/${workspaceId}`)
    await expect(page.getByRole("navigation", { name: "Sidebar navigation" })).toBeVisible({ timeout: 30_000 })
    // Give the reconcile and the operation queue a real chance to run before
    // concluding they did not: a leak here is asynchronous, not immediate.
    await expect(page.getByText(stagedBody)).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText(leakedWorkspaceName)).toHaveCount(0)

    // The unowned body never reached the server as this account's draft.
    expect(await serverDraftBodies(page, workspaceId)).not.toContain(stagedBody)

    // The app is reading a database that names its owner, not the one whose
    // contents nobody can vouch for.
    const databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((entry) => entry.name).filter((name): name is string => !!name)
    )
    expect(databases).toContain(`threa_v2_${accountId}`)

    // Both legacy records survive untouched: unreadable is not the same as gone.
    expect(await page.evaluate((key) => localStorage.getItem(key), legacyStagingKey)).toContain(stagedBody)
    expect(await legacyDatabaseRowCount(page, accountId)).toBe(1)
  })
})

test.describe("Local state an account creates after the upgrade", () => {
  test("should keep a fresh draft with its own account across a switch away, back, and a reload", async ({ page }) => {
    const { workspaceId, a, b } = await setUpSharedWorkspace(page)

    // B composes into its own scratchpad and leaves the body unsent.
    await page.goto(`/w/${workspaceId}/s/${b.scratchpadId}`)
    const composer = page.locator(COMPOSER).last()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.click()
    const draftBody = `B unsent draft ${b.scratchpadName}`
    await page.keyboard.type(draftBody)
    await expect(composer).toContainText(draftBody, { timeout: 10_000 })

    // The staged copy is filed under B, which is what makes it B's to get back.
    const stagingPrefix = await accountStorageKey(page, `draft-stage:${workspaceId}:`)
    expect(
      await page.evaluate((prefix) => {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key?.startsWith(prefix)) return true
        }
        return false
      }, stagingPrefix)
    ).toBe(true)

    // ─── Away to A: none of B's unsent body is anywhere on A's surface ───
    await openAccountPicker(page, b.profileName)
    await pickAccount(page, a.user.email)
    await expect(page.getByRole("navigation", { name: "Sidebar navigation" })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(draftBody)).toHaveCount(0, { timeout: 15_000 })

    await page.goto(`/w/${workspaceId}/s/${a.scratchpadId}`)
    const composerA = page.locator(COMPOSER).last()
    await expect(composerA).toBeVisible({ timeout: 30_000 })
    await expect(composerA).not.toContainText(draftBody)

    // ─── Back to B, then a cold reload: B's own work is still there ───
    await openAccountPicker(page, a.profileName)
    await pickAccount(page, b.user.email)
    await page.goto(`/w/${workspaceId}/s/${b.scratchpadId}`)
    await expect(page.locator(COMPOSER).last()).toContainText(draftBody, { timeout: 30_000 })

    await page.reload()
    await expect(page.locator(COMPOSER).last()).toContainText(draftBody, { timeout: 30_000 })
  })
})
