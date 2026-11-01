import { test, expect } from "@playwright/test"

/**
 * The theme class must also switch the browser's own chrome — native scrollbars,
 * form controls — via `color-scheme`. Without it the dark UI got a light-scheme
 * scrollbar (white track) on desktops that show classic scrollbars.
 */

// A public page that stays put: "/" chains through /login to the test auth stub, which carries no theme.
const PUBLIC_PAGE = "/join/inv_theme_probe"

test.describe("theme color-scheme", () => {
  test.describe("dark system preference", () => {
    test.use({ colorScheme: "dark" })

    test("native chrome renders in the dark scheme", async ({ page }) => {
      await page.goto(PUBLIC_PAGE)
      const html = page.locator("html")
      await expect(html).toHaveCSS("color-scheme", "dark")
      await expect(html).toHaveClass(/\bdark\b/)
    })
  })

  test.describe("light system preference", () => {
    test.use({ colorScheme: "light" })

    test("native chrome renders in the light scheme", async ({ page }) => {
      await page.goto(PUBLIC_PAGE)
      const html = page.locator("html")
      await expect(html).toHaveCSS("color-scheme", "light")
      await expect(html).not.toHaveClass(/\bdark\b/)
    })
  })
})
