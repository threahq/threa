import { test, expect, request as playwrightRequest, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

/**
 * The service worker pre-fetches and caches the workspace bootstrap every time
 * the tab hides — i.e. every phone lock — with no TTL. A preference changed
 * while the device was away must still land when it comes back, rather than
 * being overwritten by that lock-time snapshot.
 *
 * Only a real service worker exercises this: the dev server never registers one
 * (`/sw.js` 404s to index.html), and jsdom has no CacheStorage. It therefore
 * needs the production frontend build — `PLAYWRIGHT_PROD_FRONTEND=1` locally,
 * which CI uses by default.
 */

async function swControls(page: Page): Promise<boolean> {
  return page.evaluate(() => !!navigator.serviceWorker?.controller)
}

/** The composer action side the app has actually applied, read from IDB. */
async function appliedSide(page: Page, workspaceId: string): Promise<string> {
  return page.evaluate(async (wid) => {
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue
      const value = await new Promise<string | null>((resolve) => {
        const req = indexedDB.open(name)
        req.onerror = () => resolve(null)
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains("userPreferences")) return resolve(null)
          const get = db.transaction("userPreferences", "readonly").objectStore("userPreferences").get(wid)
          get.onerror = () => resolve(null)
          get.onsuccess = () =>
            resolve(
              (get.result as { accessibility?: { composerActionSide?: string } })?.accessibility?.composerActionSide ??
                null
            )
        }
      })
      if (value) return value
    }
    return "NOT_FOUND"
  }, workspaceId)
}

test.describe("Service worker bootstrap staleness", () => {
  test("a preference changed while the device was away survives the lock-time bootstrap snapshot", async ({
    page,
    context,
  }) => {
    await loginAndCreateWorkspace(page, "sw-stale")
    const workspaceId = page.url().match(/\/w\/([^/?]+)/)![1]

    await expect
      .poll(() => swControls(page), {
        timeout: 15000,
        message: "Production service worker did not take control; run with PLAYWRIGHT_PROD_FRONTEND=1",
      })
      .toBe(true)

    const mk = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "scratchpad", displayName: "sw stale pad" },
    })
    await expectApiOk(mk, "create scratchpad")
    const streamId = (await mk.json())?.stream?.id

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 20000 })
    expect(await appliedSide(page, workspaceId)).toBe("right")

    // Lock the phone: the hide handler has the SW pre-fetch and cache the
    // bootstrap as it stands right now.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await expect
      .poll(
        () =>
          page.evaluate(async (wid) => {
            const cache = await caches.open("push-bootstrap")
            return !!(await cache.match(`/api/workspaces/${wid}/bootstrap`))
          }, workspaceId),
        { timeout: 15000, message: "SW never cached the bootstrap on hide" }
      )
      .toBe(true)

    // Away, so the live event cannot be delivered.
    await context.setOffline(true)
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
      document.dispatchEvent(new Event("visibilitychange"))
    })

    // Another device flips the preference. Separate request context so it is
    // unaffected by this one being offline.
    const api = await playwrightRequest.newContext({
      baseURL: page.url().split("/w/")[0],
      storageState: await context.storageState(),
    })
    await expectApiOk(
      await api.patch(`/api/workspaces/${workspaceId}/preferences`, {
        data: { accessibility: { composerActionSide: "left" } },
      }),
      "flip the preference from the other device"
    )

    // Come back and cold-start, which is what an evicted locked PWA does. Clear
    // the persisted sync cursor to pin that precondition rather than leave it to
    // however the harness happens to treat IDB across a reload: an evicted app
    // re-seeds its cursor, and that re-seed is the step under test. Without this
    // the reload could resume from a surviving cursor and heal through ordinary
    // catch-up, which would make the assertion below pass either way.
    await page.evaluate(async () => {
      for (const { name } of await indexedDB.databases()) {
        if (!name) continue
        await new Promise<void>((resolve) => {
          const req = indexedDB.open(name)
          req.onerror = () => resolve()
          req.onsuccess = () => {
            const db = req.result
            if (!db.objectStoreNames.contains("syncCursors")) return resolve()
            const tx = db.transaction("syncCursors", "readwrite")
            tx.objectStore("syncCursors").clear()
            tx.oncomplete = () => resolve()
            tx.onerror = () => resolve()
          }
        })
      }
    })

    await context.setOffline(false)
    await page.reload()
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 20000 })

    await expect
      .poll(() => appliedSide(page, workspaceId), {
        timeout: 20000,
        message: "the away-change never landed — a stale snapshot won and nothing replayed it",
      })
      .toBe("left")

    await api.dispose()
  })
})
