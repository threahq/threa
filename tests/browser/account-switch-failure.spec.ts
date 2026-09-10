import { test, expect } from "@playwright/test"
import { openAccountPicker, setUpSharedWorkspace } from "./account-fixtures"
import { expectApiOk } from "./helpers"

test.describe.configure({ timeout: 180_000 })

test("should resume a pending send under its owner when switching accounts fails", async ({ page }) => {
  const { workspaceId, a, b } = await setUpSharedWorkspace(page)
  await page.goto(`/w/${workspaceId}/s/${b.scratchpadId}`)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/workspaces/*/messages", async (route) => {
    if (route.request().method() === "POST") await gate
    await route.continue()
  })
  await page.route("**/api/accounts/switch", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Switch temporarily unavailable" }),
    })
  )

  const text = `send-after-failed-switch-${Date.now()}`
  const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
  await expect(composer).toBeVisible()
  await composer.fill(text)
  await composer.press("Enter")
  await expect(page.locator("[data-author-name]").filter({ hasText: text }).first()).toBeVisible()
  await openAccountPicker(page, b.profileName)
  const failed = page.waitForResponse((response) => response.url().endsWith("/api/accounts/switch"))
  await page
    .getByRole("dialog")
    .filter({ has: page.getByText("Switch account") })
    .getByRole("button")
    .filter({ hasText: a.user.email })
    .first()
    .click()
  expect((await failed).status()).toBe(503)
  release()

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/workspaces/${workspaceId}/streams/${b.scratchpadId}/events?limit=100`
        )
        await expectApiOk(response, "Read originating stream after failed switch")
        const body = (await response.json()) as { events: Array<{ payload?: { contentMarkdown?: string } }> }
        return body.events.filter((event) => event.payload?.contentMarkdown?.includes(text)).length
      },
      { timeout: 30_000 }
    )
    .toBe(1)

  const me = await page.request.get("/api/auth/me")
  await expectApiOk(me, "Read identity after failed switch")
  expect((await me.json()).id).toBe(b.user.id)
})
