import { test, expect, type Page, type Locator } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 120_000 })

function sectionByHeading(page: Page, heading: string): Locator {
  return page.locator("div.mb-4", { has: page.getByRole("heading", { name: heading, level: 3 }) })
}

function sidebarRow(section: Locator, streamId: string): Locator {
  return section.locator(`.reveal-host:has(a[href*="/s/${streamId}"])`)
}

async function createChannelAway(page: Page, workspaceId: string, name: string): Promise<string> {
  await createChannel(page, name)
  const streamId = page.url().match(/\/s\/([^/?]+)/)![1]
  await page.goto(`/w/${workspaceId}/streams`)
  return streamId
}

async function channelOrder(page: Page, streamIds: string[]): Promise<string[]> {
  const hrefs = await sectionByHeading(page, "Channels")
    .locator('.reveal-host a[href*="/s/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))
  return hrefs
    .map((href) => streamIds.find((id) => href.includes(`/s/${id}`)))
    .filter((id): id is string => id !== undefined)
}

test.describe("Sidebar section filter toggle", () => {
  test("toggling unread-only hides quiet rows, and the choice persists across reload", async ({ page, browser }) => {
    const owner = await loginAndCreateWorkspace(page, "sec-filter")
    const testId = owner.testId
    const workspaceId = page.url().match(/\/w\/([^/?]+)/)![1]

    // Channels sort alphabetically by name (`sortStreamsStatic`), not by
    // creation order — name them so the quiet one sorts first.
    const quietId = await createChannelAway(page, workspaceId, `sf-a-quiet-${testId}`)
    const activeId = await createChannelAway(page, workspaceId, `sf-b-active-${testId}`)

    const other = await loginInNewContext(browser, `sec-filter-b-${testId}@example.com`, `Sec Filter B ${testId}`)
    await expectApiOk(
      await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member", name: `Sec Filter B ${testId}` },
      }),
      "Second user joins workspace"
    )
    await expectApiOk(
      await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${activeId}/join`, { data: {} }),
      "Second user joins the active channel"
    )
    await expectApiOk(
      await other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId: activeId, content: `[${testId}] unread hello` },
      }),
      "Second user posts an unread message"
    )

    await page.reload()

    const channelsSection = sectionByHeading(page, "Channels")
    await expect(sidebarRow(channelsSection, quietId)).toBeVisible({ timeout: 10000 })
    await expect(sidebarRow(channelsSection, activeId)).toBeVisible({ timeout: 10000 })

    // Order stays put: another user's unread message into a home-section
    // stream never reorders it within the section (static home order).
    await expect.poll(() => channelOrder(page, [quietId, activeId]), { timeout: 10000 }).toEqual([quietId, activeId])

    const toggle = channelsSection.getByRole("button", { name: "Show unread only in Channels" })
    await expect(toggle).toBeVisible()
    await toggle.click()

    // Only the unread channel stays visible; the quiet one hides behind "1 more".
    await expect(sidebarRow(channelsSection, activeId)).toBeVisible({ timeout: 10000 })
    await expect(sidebarRow(channelsSection, quietId)).toHaveCount(0)
    await expect(channelsSection.getByRole("button", { name: "1 more" })).toBeVisible()

    // The filter persists in the synced sidebar config.
    await page.reload()
    const reloadedSection = sectionByHeading(page, "Channels")
    const reloadedToggle = reloadedSection.getByRole("button", { name: "Show all in Channels" })
    await expect(reloadedToggle).toBeVisible({ timeout: 10000 })
    await expect(reloadedToggle).toHaveAttribute("aria-pressed", "true")
    await expect(sidebarRow(reloadedSection, activeId)).toBeVisible({ timeout: 10000 })
    await expect(sidebarRow(reloadedSection, quietId)).toHaveCount(0)
    await expect(reloadedSection.getByRole("button", { name: "1 more" })).toBeVisible()

    // Toggling back shows every row again.
    await reloadedToggle.click()
    await expect(reloadedSection.getByRole("button", { name: "Show unread only in Channels" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
    await expect(sidebarRow(reloadedSection, quietId)).toBeVisible({ timeout: 10000 })
    await expect(sidebarRow(reloadedSection, activeId)).toBeVisible({ timeout: 10000 })

    await other.context.close()
  })
})
