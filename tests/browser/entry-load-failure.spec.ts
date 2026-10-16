import { test, expect, type Page } from "@playwright/test"
import { devLogin } from "./helpers"

// The entry module is `/src/main.tsx` under the dev server and a hashed
// `/assets/index-*.js` under `vite preview` (CI); both end up as the one
// `<script type="module">` in index.html.
const ENTRY_MODULE = /\/(src\/main\.tsx|assets\/index-[^/]+\.js)(\?.*)?$/
const POSTHOG_HOST = "https://posthog.test"

async function captureBeacons(page: Page): Promise<unknown[]> {
  const events: unknown[] = []
  await page.route(`${POSTHOG_HOST}/**`, async (route) => {
    const data = new URLSearchParams(route.request().postData() ?? "").get("data") ?? ""
    events.push(JSON.parse(Buffer.from(data, "base64").toString("utf8")))
    await route.fulfill({ status: 200, body: "{}" })
  })
  return events
}

test("should show the reload card when the entry module fails to load", async ({ page }) => {
  await page.route(ENTRY_MODULE, (route) => route.abort("failed"))
  await page.goto("/")

  const card = page.getByRole("alert")
  await expect(card).toContainText("Threa didn't load")
  await expect(card.getByRole("button", { name: "Reload" })).toBeVisible()
  await expect(card.getByRole("link", { name: /Reset the app/ })).toHaveAttribute("href", "/recover.html")
})

test("should report one entry-load failure per interval with a consented analytics scope", async ({ page }) => {
  const events = await captureBeacons(page)
  await page.addInitScript((host) => {
    localStorage.setItem("threa-analytics", JSON.stringify({ token: "tok_test", host, distinctId: "usr_test" }))
  }, POSTHOG_HOST)
  await page.route(ENTRY_MODULE, (route) => route.abort("failed"))

  await page.goto("/")
  await expect(page.getByRole("alert")).toBeVisible()
  await expect.poll(() => events.length).toBe(1)

  expect(events[0]).toMatchObject({
    api_key: "tok_test",
    event: "app_entry_load_failed",
    distinct_id: "usr_test",
    properties: { $lib: "threa-shell", trigger: "script-error", asset_url: expect.stringMatching(ENTRY_MODULE) },
  })

  await page.reload()
  await expect(page.getByRole("alert")).toBeVisible()
  await page.waitForTimeout(500)
  expect(events).toHaveLength(1)
})

test("should not report an entry-load failure without a consented analytics scope", async ({ page }) => {
  const events = await captureBeacons(page)
  await page.route(ENTRY_MODULE, (route) => route.abort("failed"))

  await page.goto("/")
  await expect(page.getByRole("alert")).toBeVisible()
  await page.waitForTimeout(500)

  expect(events).toHaveLength(0)
})

test("should keep the CSS watchdog reloading when the only stylesheet with rules is the card's", async ({ page }) => {
  await page.route(/\/$/, async (route) => {
    const response = await route.fetch()
    const html = (await response.text())
      .replace(/<script type="module"[^>]*>[^<]*<\/script>/g, "")
      .replace(/<link rel="stylesheet"[^>]*>/g, "")
      .replace("</head>", '<link rel="stylesheet" href="/empty-entry-test.css" /></head>')
    await route.fulfill({ response, body: html })
  })
  await page.route("**/empty-entry-test.css", (route) => route.fulfill({ contentType: "text/css", body: "" }))

  await page.goto("/")

  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("sw-recovery-attempts")), { timeout: 15_000 })
    .toBe("2")
})

test("should remove the card once the entry module runs", async ({ page }) => {
  await devLogin(page, `entry-load-${Date.now()}@example.com`, "Entry Load")
  await page.goto("/workspaces")
  await expect(page.locator("#root")).not.toBeEmpty()
  await expect(page.locator("#entry-failure")).toHaveCount(0)
})
