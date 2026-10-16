import { test, expect } from "@playwright/test"
import { devLogin } from "./helpers"

// The entry module is `/src/main.tsx` under the dev server and a hashed
// `/assets/index-*.js` under `vite preview` (CI); both end up as the one
// `<script type="module">` in index.html.
const ENTRY_MODULE = /\/(src\/main\.tsx|assets\/index-[^/]+\.js)(\?.*)?$/

test("should show the reload card when the entry module fails to load", async ({ page }) => {
  await page.route(ENTRY_MODULE, (route) => route.abort("failed"))
  await page.goto("/")

  const card = page.getByRole("alert")
  await expect(card).toContainText("Threa didn't load")
  await expect(card.getByRole("button", { name: "Reload" })).toBeVisible()
  await expect(card.getByRole("link", { name: /Reset the app/ })).toHaveAttribute("href", "/recover.html")
})

test("should remove the card once the entry module runs", async ({ page }) => {
  await devLogin(page, `entry-load-${Date.now()}@example.com`, "Entry Load")
  await page.goto("/workspaces")
  await expect(page.locator("#root")).not.toBeEmpty()
  await expect(page.locator("#entry-failure")).toHaveCount(0)
})
