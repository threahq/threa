import { test, expect } from "@playwright/test"

/**
 * The theme class must also switch the browser's own chrome — native scrollbars,
 * form controls — via `color-scheme`. Without it the dark UI got a light-scheme
 * scrollbar (white track) on desktops that show classic scrollbars.
 */

async function readTheme(page: import("@playwright/test").Page) {
  await page.goto("/")
  await expect(page.locator("html")).toBeAttached()
  return page.evaluate(() => ({
    darkClass: document.documentElement.classList.contains("dark"),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }))
}

test.describe("theme color-scheme", () => {
  test.describe("dark system preference", () => {
    test.use({ colorScheme: "dark" })

    test("native chrome renders in the dark scheme", async ({ page }) => {
      expect(await readTheme(page)).toEqual({ darkClass: true, colorScheme: "dark" })
    })
  })

  test.describe("light system preference", () => {
    test.use({ colorScheme: "light" })

    test("native chrome renders in the light scheme", async ({ page }) => {
      expect(await readTheme(page)).toEqual({ darkClass: false, colorScheme: "light" })
    })
  })
})
