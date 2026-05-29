import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * Push notification settings E2E tests.
 *
 * Tests the settings UI rendering and push API endpoints.
 * Note: browser push APIs (Notification.requestPermission, pushManager.subscribe)
 * can't be fully tested — the permission prompt is a system-level dialog
 * and headless Chromium doesn't support granting push permissions reliably.
 * We test what we can: UI rendering and API layer.
 */

test.describe("Push Notification Settings", () => {
  test("settings page shows push notification section", async ({ page }) => {
    await loginAndCreateWorkspace(page, "push-settings")

    // Open settings dialog on Notifications tab via URL param
    const currentUrl = page.url()
    await page.goto(`${currentUrl}?settings=notifications`)

    // Wait for the settings dialog to load with Notifications tab
    const dialog = page.getByRole("dialog", { name: "Settings" })
    await expect(dialog).toBeVisible({ timeout: 10000 })

    // Verify notification cards are present
    await expect(dialog.getByText("Notification level")).toBeVisible()
    await expect(dialog.getByText("Push notifications", { exact: true })).toBeVisible()
    await expect(dialog.getByText(/Get notified on this device even when Threa isn't open/i)).toBeVisible()
  })

  test("shows blocked message in headless browser (default denied permission)", async ({ page }) => {
    await loginAndCreateWorkspace(page, "push-blocked")

    const currentUrl = page.url()
    await page.goto(`${currentUrl}?settings=notifications`)

    const dialog = page.getByRole("dialog", { name: "Settings" })
    await expect(dialog).toBeVisible({ timeout: 10000 })

    // Headless Chromium denies notification permission by default,
    // so the card should show the "blocked" message
    await expect(dialog.getByText(/blocked at the browser level/i)).toBeVisible({ timeout: 5000 })
  })

  test("VAPID key endpoint responds", async ({ page }) => {
    await loginAndCreateWorkspace(page, "push-vapid")

    // Extract workspaceId from URL
    const url = page.url()
    const workspaceId = url.match(/\/w\/([^/?]+)/)?.[1]
    expect(workspaceId).toBeTruthy()

    // Call the VAPID key endpoint directly
    const response = await page.request.get(`/api/workspaces/${workspaceId}/push/vapid-key`)
    expect(response.ok()).toBeTruthy()

    const body = (await response.json()) as { vapidPublicKey: string | null; enabled: boolean }
    expect(body.vapidPublicKey).toBeTruthy()
    expect(typeof body.vapidPublicKey).toBe("string")
    expect(body.enabled).toBe(true)
  })

  test("subscribe endpoint accepts subscription", async ({ page }) => {
    await loginAndCreateWorkspace(page, "push-subscribe")

    const url = page.url()
    const workspaceId = url.match(/\/w\/([^/?]+)/)?.[1]
    expect(workspaceId).toBeTruthy()

    // Post a valid subscription payload
    const response = await page.request.post(`/api/workspaces/${workspaceId}/push/subscribe`, {
      data: {
        endpoint: "https://push.example.com/test-endpoint",
        p256dh: "test-p256dh-key-value",
        auth: "test-auth-key-value",
        deviceKey: "test-device-key",
        userAgent: "Playwright/1.0",
      },
    })
    expect(response.ok()).toBeTruthy()

    const body = (await response.json()) as { subscription: { id: string } }
    expect(body.subscription.id).toMatch(/^push_sub_/)
  })
})
