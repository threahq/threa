import { test } from "@playwright/test"
import { deviceReportScenario } from "./push-receipts-scenario"

// Headless shell denies Notification.permission even when the Permissions API grants it.
test.use({ channel: "chromium" })

test.describe("Push receipts through the production service worker (desktop)", () => {
  test("a device's report reaches Settings next to a failed provider result, and pushes without a capability report nothing", async ({
    page,
    context,
  }) => {
    await deviceReportScenario(page, context, {
      name: "desktop",
      workerUserAgent: /^(?!.*Android)/,
      messageActions: ["mark_read", "remind"],
    })
  })
})
