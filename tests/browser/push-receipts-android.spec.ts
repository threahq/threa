import { devices, test } from "@playwright/test"
import { deviceReportScenario } from "./push-receipts-scenario"

const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 7"]

// The device preset changes only the page: the service worker keeps the
// browser's own user agent, so an Android worker needs it at launch. Launch
// options are per worker process, which is why this is its own file.
test.use({
  ...pixel,
  // Headless shell denies Notification.permission even when the Permissions API grants it.
  channel: "chromium",
  launchOptions: { args: [`--user-agent=${pixel.userAgent}`] },
})

test.describe("Push receipts through the production service worker (Android)", () => {
  test("a device's report reaches Settings next to a failed provider result, and pushes without a capability report nothing", async ({
    page,
    context,
  }) => {
    await deviceReportScenario(page, context, {
      name: "android",
      workerUserAgent: /\bAndroid\b/,
      // Android cannot tell which button was pressed, so its cards carry none.
      messageActions: [],
    })
  })
})
