import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

const PAD_A = "cold open pad a"
const PAD_B = "cold open pad b"
const OLD_MESSAGE = "seed message one"
const NEW_MESSAGE = "brand new message"

interface ColdOpenFrame {
  elapsed: number
  hasPadB: boolean
  preview: string
}

function sidebarItem(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Sidebar navigation" }).locator("a", { hasText: name })
}

async function idbStream(page: Page, streamId: string) {
  return page.evaluate(async (sid) => {
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue
      const row = await new Promise<{ found: boolean; preview: string | null }>((resolve, reject) => {
        const request = indexedDB.open(name)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          if (!database.objectStoreNames.contains("streams")) {
            database.close()
            resolve({ found: false, preview: null })
            return
          }
          const transaction = database.transaction("streams", "readonly")
          const get = transaction.objectStore("streams").get(sid)
          transaction.oncomplete = () => {
            database.close()
            const value = get.result as { lastMessagePreview?: { content?: string } } | undefined
            resolve({ found: !!value, preview: value?.lastMessagePreview?.content ?? null })
          }
          transaction.onabort = () => {
            database.close()
            reject(transaction.error)
          }
        }
      })
      if (row.found) return row
    }
    return { found: false, preview: null }
  }, streamId)
}

async function readFrames(page: Page): Promise<ColdOpenFrame[]> {
  return page.evaluate(() => (window as unknown as { __coldOpenFrames: ColdOpenFrame[] }).__coldOpenFrames)
}

test("should preserve cached sidebar state throughout reload when a stale SW snapshot exists", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(60_000)
  await loginAndCreateWorkspace(page, "cold-open")
  const workspaceId = page.url().match(/\/w\/([^/?]+)/)![1]
  const bootstrapUrl = `/api/workspaces/${workspaceId}/bootstrap`

  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker?.controller), {
      timeout: 15_000,
      message: "Requires a controlling service worker: run with PLAYWRIGHT_PROD_FRONTEND=1",
    })
    .toBe(true)

  const created = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "scratchpad", displayName: PAD_A, companionMode: "off" },
  })
  await expectApiOk(created, "create scratchpad a")
  const streamId: string = (await created.json()).stream.id
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 20_000 })

  const seed = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, content: OLD_MESSAGE },
  })
  await expectApiOk(seed, "seed message")
  await expect(page.getByRole("main").locator(".message-item").getByText(OLD_MESSAGE)).toBeVisible()

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  const readCachedBootstrap = () =>
    page.evaluate(async (url) => {
      const hit = await (await caches.open("push-bootstrap")).match(url)
      return hit ? { body: await hit.text(), contentType: hit.headers.get("content-type") } : null
    }, bootstrapUrl)
  await expect.poll(readCachedBootstrap, { timeout: 20_000 }).not.toBeNull()
  const staleBootstrap = (await readCachedBootstrap())!

  // The E2E build has no precached app shell. Block data requests, not navigation;
  // page.request and the existing socket can still advance server and local state.
  await context.route("**/api/**", (route) => route.abort())
  const createdB = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "scratchpad", displayName: PAD_B, companionMode: "off" },
  })
  await expectApiOk(createdB, "create scratchpad b")
  const padBId: string = (await createdB.json()).stream.id
  const newer = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, content: NEW_MESSAGE },
  })
  await expectApiOk(newer, "newer message")
  await expect
    .poll(async () => ({ a: await idbStream(page, streamId), b: (await idbStream(page, padBId)).found }))
    .toEqual({ a: { found: true, preview: NEW_MESSAGE }, b: true })
  await expect(sidebarItem(page, PAD_B)).toBeVisible()

  // A late background-sync retry must not replace the old fixture with a fresh copy.
  await page.evaluate(
    async ({ url, body, contentType }) => {
      await (
        await caches.open("push-bootstrap")
      ).put(url, new Response(body, { headers: contentType ? { "content-type": contentType } : {} }))
    },
    { url: bootstrapUrl, ...staleBootstrap }
  )
  await page.addInitScript(
    ({ padA, padB }) => {
      const frames: ColdOpenFrame[] = []
      ;(window as unknown as { __coldOpenFrames: ColdOpenFrame[] }).__coldOpenFrames = frames
      const start = performance.now()
      const sample = () => {
        const navigation = document.querySelector('[role="navigation"][aria-label="Sidebar navigation"]')
        const links = Array.from(navigation?.querySelectorAll("a") ?? [])
        const a = links.find((link) => link.textContent?.includes(padA))
        if (a && a.getClientRects().length > 0) {
          const b = links.find((link) => link.textContent?.includes(padB))
          frames.push({
            elapsed: performance.now() - start,
            hasPadB: !!b && b.getClientRects().length > 0,
            preview: a.textContent ?? "",
          })
        }
        if (performance.now() - start < 30_000) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    },
    { padA: PAD_A, padB: PAD_B }
  )
  await page.reload()
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => {
      const frames = await readFrames(page)
      return frames.length > 0 ? frames[frames.length - 1].elapsed - frames[0].elapsed : 0
    })
    .toBeGreaterThanOrEqual(1_000)

  const frames = await readFrames(page)
  await testInfo.attach("cached-sidebar-frames", { body: JSON.stringify(frames), contentType: "application/json" })
  expect(frames.filter((frame) => !frame.hasPadB || frame.preview.includes(OLD_MESSAGE))).toEqual([])
  await expect
    .poll(async () => ({ a: await idbStream(page, streamId), b: (await idbStream(page, padBId)).found }))
    .toEqual({ a: { found: true, preview: NEW_MESSAGE }, b: true })
  await expect(page.getByRole("main").locator(".message-item").getByText(NEW_MESSAGE)).toBeVisible()
})
