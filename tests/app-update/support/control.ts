import { expect, type Locator, type Page } from "@playwright/test"
import { readServerPort } from "./port"

let cachedUrl: string | null = null

export async function serverUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl
  const port = Number(process.env.APP_UPDATE_SERVER_PORT) || (await readServerPort())
  if (!port) throw new Error("app-update server port is not known")
  cachedUrl = `http://127.0.0.1:${port}`
  return cachedUrl
}

async function control(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
  const res = await fetch(`${await serverUrl()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<Record<string, unknown>>
}

export const controlApi = {
  reset: () => control("POST", "/__control/reset"),
  setDeployed: (version: string) => control("POST", "/__control/deployed", { version }),
  setLatest: (version: string) => control("POST", "/__control/latest", { version }),
  failWorker: (fail: boolean) => control("POST", "/__control/fail-worker", { fail }),
  failAsset: (path: string) => control("POST", "/__control/fail-asset", { path }),
  clearFailAsset: (path: string) => control("POST", "/__control/clear-fail-asset", { path }),
  corruptAsset: (path: string) => control("POST", "/__control/corrupt-asset", { path }),
  clearCorruptAsset: (path: string) => control("POST", "/__control/clear-corrupt-asset", { path }),
  state: () => control("GET", "/__control/state"),
}

export async function waitForControlled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15000 }).toBe(true)
}

export async function fixtureVersion(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__fixtureVersion)
}

export async function fixtureBuildId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__fixtureBuildId)
}

interface ClickApplyState {
  phase: string | undefined
  toastActionPresent: boolean
}

export async function clickAndReadApplyState(locator: Locator): Promise<ClickApplyState> {
  return locator.evaluate((el) => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }))
    return new Promise<ClickApplyState>((resolve) => {
      let attempts = 0
      const read = () => {
        attempts++
        const toastButton = document.querySelector("[data-sonner-toast] [data-button]")
        const state = { phase: window.__appUpdateState?.phase, toastActionPresent: !!toastButton }
        if (state.phase !== "applying" || !state.toastActionPresent || attempts >= 5) resolve(state)
        else requestAnimationFrame(read)
      }
      requestAnimationFrame(read)
    })
  })
}

export async function clickAndReadPhase(locator: Locator): Promise<string | undefined> {
  return (await clickAndReadApplyState(locator)).phase
}

export async function workerStatus(page: Page, target: "controller" | "waiting" | "active") {
  return page.evaluate(async (kind) => {
    const registration = await navigator.serviceWorker.getRegistration()
    const worker = kind === "controller" ? navigator.serviceWorker.controller : registration?.[kind]
    if (!worker) return null
    return new Promise<{ buildId: string; ready: boolean } | null>((resolve) => {
      const channel = new MessageChannel()
      const finish = (value: { buildId: string; ready: boolean } | null) => {
        clearTimeout(timer)
        channel.port1.close()
        channel.port2.close()
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), 1500)
      channel.port1.onmessage = (event) => {
        const data = event.data as { type?: string; buildId?: string; ready?: boolean }
        finish(
          data.type === "STATUS_REPLY" && typeof data.buildId === "string"
            ? { buildId: data.buildId, ready: data.ready === true }
            : null
        )
      }
      worker.postMessage({ type: "QUERY_STATUS" }, [channel.port2])
    })
  }, target)
}

export async function importLazyFixture(page: Page): Promise<string> {
  return page.evaluate(() => {
    if (!window.__importLazyFixture) throw new Error("__importLazyFixture not exposed")
    return window.__importLazyFixture()
  })
}

export async function hasCacheEntry(page: Page, url: string): Promise<boolean> {
  return page.evaluate((u) => caches.match(u).then(Boolean), url)
}

export async function hasCustomCache(page: Page, name: string): Promise<boolean> {
  return page.evaluate((n) => caches.has(n), name)
}

export async function setLocalDraftSentinel(page: Page, key: string, value: string): Promise<void> {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key, value })
}

export async function getLocalDraftSentinel(page: Page, key: string): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), key)
}

export async function createDomainCacheSentinel(page: Page, name: string, url: string): Promise<void> {
  await page.evaluate(
    ({ name, url }) => caches.open(name).then((cache) => cache.put(url, new Response("domain-sentinel"))),
    { name, url }
  )
}

export async function precacheNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith("workbox-precache-")))
}

export async function seedPrecacheEntry(
  page: Page,
  name: string,
  url: string,
  body: string,
  contentType = "application/javascript"
): Promise<void> {
  await page.evaluate(
    ({ name, url, body, contentType }) =>
      caches
        .open(name)
        .then((cache) => cache.put(url, new Response(body, { headers: { "content-type": contentType } }))),
    { name, url, body, contentType }
  )
}

export async function runGc(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.controller?.postMessage({ type: "RUN_GC" }))
}
