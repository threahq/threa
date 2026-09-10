import { test, expect } from "@playwright/test"
import { expectApiOk } from "./helpers"
import { openAccountPicker, pickAccount, setUpSharedWorkspace } from "./account-fixtures"

const COMPOSER = "[data-editor-zone='main'] [contenteditable='true']"

test.describe.configure({ timeout: 180_000 })

test("should refuse a stale tab's send rather than author it as the account selected in another tab", async ({
  page,
  context,
}) => {
  const { workspaceId, a, b } = await setUpSharedWorkspace(page)
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug: `shared-${Date.now()}`, visibility: "public" },
  })
  await expectApiOk(response, "Create shared channel")
  const { stream } = (await response.json()) as { stream: { id: string } }

  const staleTab = await context.newPage()
  await staleTab.addInitScript(() => {
    const NativeChannel = window.BroadcastChannel
    window.BroadcastChannel = new Proxy(NativeChannel, {
      construct(target, args) {
        const channel = Reflect.construct(target, args)
        if (args[0] === "threa-auth") {
          Object.defineProperty(channel, "onmessage", { get: () => null, set: () => {} })
        }
        return channel
      },
    })
  })
  await staleTab.goto(`/w/${workspaceId}/s/${stream.id}`)
  const sidebar = staleTab.getByRole("navigation", { name: "Sidebar navigation" })
  await expect(sidebar.getByText(b.profileName, { exact: true })).toBeVisible({ timeout: 30_000 })
  const composer = staleTab.locator(COMPOSER).last()
  await expect(composer).toBeVisible()
  const body = `stale-tab-send-${Date.now()}`
  await composer.fill(body)

  await openAccountPicker(page, b.profileName)
  await pickAccount(page, a.user.email)
  await expect(
    page.getByRole("navigation", { name: "Sidebar navigation" }).getByText(a.profileName, { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(sidebar.getByText(b.profileName, { exact: true })).toBeVisible()

  const refused = staleTab.waitForResponse(
    (result) => result.request().method() === "POST" && result.url().endsWith(`/api/workspaces/${workspaceId}/messages`)
  )
  await composer.press("Enter")
  const refusal = await refused
  expect({ status: refusal.status(), code: (await refusal.json()).code }).toEqual({
    status: 409,
    code: "ACCOUNT_MISMATCH",
  })
  await expect(sidebar.getByText(a.profileName, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(staleTab.getByText(b.scratchpadName, { exact: true })).toHaveCount(0)
  await expect(staleTab.getByText(body, { exact: true })).toHaveCount(0)

  const eventsResponse = await page.request.get(`/api/workspaces/${workspaceId}/streams/${stream.id}/events?limit=100`)
  await expectApiOk(eventsResponse, "Read shared channel events")
  const events = (await eventsResponse.json()) as { events: Array<{ payload?: { contentMarkdown?: string } }> }
  expect(events.events.filter((event) => event.payload?.contentMarkdown?.includes(body))).toEqual([])
  await staleTab.close()
})
