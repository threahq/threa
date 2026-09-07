import { test, expect } from "@playwright/test"
import {
  controlApi,
  waitForControlled,
  fixtureVersion,
  clickAndReadPhase,
  clickAndReadApplyState,
  importLazyFixture,
  hasCacheEntry,
  hasCustomCache,
  createDomainCacheSentinel,
  setLocalDraftSentinel,
  getLocalDraftSentinel,
  precacheNames,
  seedPrecacheEntry,
  runGc,
  workerStatus,
} from "../support/control"

interface Generation {
  buildId: string
  entryAsset: string
}

async function generations(): Promise<Record<string, Generation>> {
  const state = await controlApi.state()
  return state.generations as Record<string, Generation>
}

async function installWaiting(page: import("@playwright/test").Page, version: string): Promise<void> {
  await controlApi.setDeployed(version)
  await controlApi.setLatest(version)
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((registration) => registration?.update()))
  const buildId = (await generations())[version].buildId
  await expect.poll(() => workerStatus(page, "waiting"), { timeout: 20000 }).toEqual({ buildId, ready: true })
}

test.describe.configure({ mode: "serial" })

test.beforeEach(async ({ page }) => {
  await controlApi.reset()
  await page.goto("/")
  await waitForControlled(page)
})

test("baseline offline reload keeps build A", async ({ page, context }) => {
  await context.setOffline(true)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect.poll(() => fixtureVersion(page)).toBe("A")
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
})

test("ready build B applies in one reload", async ({ page }) => {
  await installWaiting(page, "B")
  const button = page.getByRole("button", { name: /reload and update/i })
  await button.waitFor()
  const reloads: string[] = []
  page.on("framenavigated", (frame) => frame === page.mainFrame() && reloads.push(frame.url()))

  await button.click()
  await expect.poll(() => fixtureVersion(page), { timeout: 20000 }).toBe("B")
  expect(reloads).toHaveLength(1)
})

test("ready build B applies offline in one reload without clearing domain data", async ({ page, context }) => {
  await createDomainCacheSentinel(page, "threa-test-domain", "/__domain-sentinel")
  await setLocalDraftSentinel(page, "threa-test-draft", "saved")
  await installWaiting(page, "B")
  const button = page.getByRole("button", { name: /reload and update/i })
  await button.waitFor()
  const reloads: string[] = []
  page.on("framenavigated", (frame) => frame === page.mainFrame() && reloads.push(frame.url()))

  await context.setOffline(true)
  await button.click()
  await expect.poll(() => fixtureVersion(page), { timeout: 20000 }).toBe("B")
  expect(reloads).toHaveLength(1)
  expect(await hasCustomCache(page, "threa-test-domain")).toBe(true)
  expect(await getLocalDraftSentinel(page, "threa-test-draft")).toBe("saved")
})

test("should keep update controls usable on a narrow screen", async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installWaiting(page, "B")
  const button = page.getByRole("button", { name: /reload and update/i })
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  await expect(button).toHaveCSS("display", "flex")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("app-status-mobile.png"), fullPage: true })
  await context.setOffline(true)
  await button.click()
  await expect.poll(() => fixtureVersion(page), { timeout: 20000 }).toBe("B")
})

test("toast shows busy while applying from AppStatus", async ({ page }) => {
  await installWaiting(page, "B")
  const toastAction = page.locator("[data-sonner-toast]").getByRole("button")
  const pageButton = page.getByRole("button", { name: /reload and update/i })
  await expect(toastAction).toBeEnabled()
  await expect(pageButton).toBeEnabled()

  const navigated = page.waitForNavigation({ waitUntil: "domcontentloaded" })
  expect(await clickAndReadPhase(pageButton)).toBe("applying")
  await navigated
  await expect.poll(() => fixtureVersion(page)).toBe("B")
})

test("duplicate apply clicks are unavailable across AppStatus and AppToastHost", async ({ page }) => {
  await installWaiting(page, "B")
  const pageButton = page.getByRole("button", { name: /reload and update/i })
  await expect(pageButton).toBeEnabled()
  await expect(page.locator("[data-sonner-toast]").getByRole("button")).toBeEnabled()

  const navigated = page.waitForNavigation({ waitUntil: "domcontentloaded" })
  expect(await clickAndReadApplyState(pageButton)).toEqual({ phase: "applying", toastActionPresent: false })
  await navigated
  await expect.poll(() => fixtureVersion(page)).toBe("B")
})

test("old A tab imports its precached lazy chunk offline after B activates", async ({ page, context }) => {
  const oldTab = await context.newPage()
  await oldTab.goto("/")
  await waitForControlled(oldTab)

  await installWaiting(page, "B")
  const button = page.getByRole("button", { name: /reload and update/i })
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), button.click()])
  await expect.poll(() => fixtureVersion(page)).toBe("B")
  expect(await fixtureVersion(oldTab)).toBe("A")

  await context.setOffline(true)
  expect(await importLazyFixture(oldTab)).toBe("A")
  const lazyUrl = await oldTab.evaluate(() => window.__fixtureLazyUrl)
  expect(lazyUrl).toBeTruthy()
  expect(await hasCacheEntry(oldTab, lazyUrl!)).toBe(true)
})

for (const failure of ["interrupted", "corrupted"] as const) {
  test(`${failure} B entry install preserves A and domain data`, async ({ page }) => {
    await createDomainCacheSentinel(page, "threa-test-domain", "/__domain-sentinel")
    await setLocalDraftSentinel(page, "threa-test-draft", "saved")
    const entry = (await generations()).B.entryAsset
    if (failure === "interrupted") await controlApi.failAsset(entry)
    else await controlApi.corruptAsset(entry)

    await controlApi.setDeployed("B")
    await controlApi.setLatest("B")
    await page.evaluate(() =>
      navigator.serviceWorker
        .getRegistration()
        .then((r) => r?.update())
        .catch(() => undefined)
    )

    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await navigator.serviceWorker.getRegistration()
          return { waiting: r?.waiting?.state ?? null, installing: r?.installing?.state ?? null }
        })
      )
      .toEqual({ waiting: null, installing: null })
    expect(await fixtureVersion(page)).toBe("A")
    expect(await hasCustomCache(page, "threa-test-domain")).toBe(true)
    expect(await getLocalDraftSentinel(page, "threa-test-draft")).toBe("saved")
  })
}

test("failed sw.js with latest B neither offers reload nor blinds A", async ({ page }) => {
  await controlApi.setDeployed("B")
  await controlApi.setLatest("B")
  await controlApi.failWorker(true)
  await page.evaluate(() =>
    navigator.serviceWorker
      .getRegistration()
      .then((r) => r?.update())
      .catch(() => undefined)
  )

  expect(await fixtureVersion(page)).toBe("A")
  await expect(page.getByRole("button", { name: /reload and update/i })).not.toBeAttached()
})

test("ready B with server latest C reloads to B without wiping caches", async ({ page }) => {
  await createDomainCacheSentinel(page, "threa-test-domain", "/__domain-sentinel")
  await installWaiting(page, "B")
  await controlApi.setLatest("C")
  const reloads: string[] = []
  page.on("framenavigated", (frame) => frame === page.mainFrame() && reloads.push(frame.url()))

  await page.getByRole("button", { name: /reload and update/i }).click()
  await expect.poll(() => fixtureVersion(page), { timeout: 20000 }).toBe("B")
  expect(reloads).toHaveLength(1)
  expect(await hasCustomCache(page, "threa-test-domain")).toBe(true)
})

test("legacy SKIP_WAITING activates the actual B worker without an unsolicited reload", async ({ page, context }) => {
  await installWaiting(page, "B")
  const buildB = (await generations()).B.buildId
  const reloads: string[] = []
  page.on("framenavigated", (frame) => frame === page.mainFrame() && reloads.push(frame.url()))

  await page.evaluate(() =>
    navigator.serviceWorker.getRegistration().then((r) => r?.waiting?.postMessage({ type: "SKIP_WAITING" }))
  )
  await expect
    .poll(() => workerStatus(page, "controller"), { timeout: 20000 })
    .toEqual({ buildId: buildB, ready: true })
  expect(reloads).toEqual([])
  expect(await fixtureVersion(page)).toBe("A")

  await context.setOffline(true)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect.poll(() => fixtureVersion(page)).toBe("B")
})

test("C superseding waiting B retains A and C precaches and removes B", async ({ page }) => {
  const info = await generations()
  await installWaiting(page, "B")
  expect(await precacheNames(page)).toEqual(
    expect.arrayContaining([`workbox-precache-${info.A.buildId}`, `workbox-precache-${info.B.buildId}`])
  )

  await controlApi.setDeployed("C")
  await controlApi.setLatest("C")
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()))
  await expect
    .poll(() => workerStatus(page, "waiting"), { timeout: 20000 })
    .toEqual({
      buildId: info.C.buildId,
      ready: true,
    })

  await runGc(page)
  await expect
    .poll(async () => (await precacheNames(page)).sort())
    .toEqual([`workbox-precache-${info.A.buildId}`, `workbox-precache-${info.C.buildId}`].sort())
})

test("asset fallback rejects poisoned HTML and returns valid retained JS offline", async ({ page, context }) => {
  const blank = await context.newPage()
  await blank.goto("/recover/blank.html")
  await waitForControlled(blank)

  const url = "/assets/legacy-poison-12345678.js"
  await seedPrecacheEntry(page, "workbox-precache-poison", url, "<!doctype html>poison", "text/html")
  await seedPrecacheEntry(page, "workbox-precache-valid", url, "export default 'retained'")
  await context.setOffline(true)

  expect(await page.evaluate((assetUrl) => import(assetUrl).then((mod) => mod.default), url)).toBe("retained")
})

test("unknown client retains legacy precache until it closes", async ({ page, context }) => {
  const blank = await context.newPage()
  await blank.goto("/recover/blank.html")
  await waitForControlled(blank)
  await seedPrecacheEntry(page, "workbox-precache-legacy-v1", "/legacy-asset.js", "legacy")
  await createDomainCacheSentinel(page, "threa-test-domain", "/__domain-sentinel")

  await runGc(page)
  await expect.poll(() => precacheNames(page)).toContain("workbox-precache-legacy-v1")
  await blank.close()
  await expect
    .poll(
      async () => {
        await runGc(page)
        return precacheNames(page)
      },
      { timeout: 15000 }
    )
    .not.toContain("workbox-precache-legacy-v1")
  expect(await hasCustomCache(page, "threa-test-domain")).toBe(true)
})

test("server returns 404 for missing assets and shell only for extensionless navigation", async ({ request }) => {
  const asset = await request.get("/assets/missing.js")
  expect({ status: asset.status(), cacheControl: asset.headers()["cache-control"] }).toEqual({
    status: 404,
    cacheControl: "no-store",
  })

  const navigation = await request.get("/some/app/route")
  expect({ status: navigation.status(), contentType: navigation.headers()["content-type"] }).toEqual({
    status: 200,
    contentType: "text/html",
  })
})
