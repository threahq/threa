import { test, expect, type Page, type Locator, type Browser, type BrowserContext } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 150_000 })

async function enableInboxSection(page: Page, workspaceId: string): Promise<void> {
  const response = await page.request.patch(`/api/workspaces/${workspaceId}/sidebar-config`, {
    data: {
      basePreset: "all",
      sections: [
        { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
        { id: "channels", spec: { kind: "type", streamType: "channel" } },
        { id: "dms", spec: { kind: "type", streamType: "dm" } },
        { id: "unread", spec: { kind: "unread" } },
      ],
    },
  })
  await expectApiOk(response, "Enable Inbox sidebar section")
}

async function setPreferences(page: Page, workspaceId: string, data: Record<string, string>): Promise<void> {
  await expectApiOk(
    await page.request.patch(`/api/workspaces/${workspaceId}/preferences`, { data }),
    `Set preferences ${JSON.stringify(data)}`
  )
}

async function serverUnreadCount(page: Page, workspaceId: string, streamId: string): Promise<number> {
  const res = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(res, "Workspace bootstrap")
  const body = (await res.json()) as { data?: { unreadCounts?: Record<string, number> } }
  return body.data?.unreadCounts?.[streamId] ?? 0
}

function sectionByHeading(page: Page, heading: string): Locator {
  return page.locator("div.mb-4", { has: page.getByRole("heading", { name: heading, level: 3 }) })
}

function sidebarRow(section: Locator, streamId: string): Locator {
  return section.locator(`.reveal-host:has(a[href*="/s/${streamId}"])`)
}

async function isDimmed(row: Locator): Promise<boolean> {
  return (await row.locator(".opacity-60").count()) > 0
}

async function inboxOrder(page: Page, streamIds: string[]): Promise<string[]> {
  const hrefs = await sectionByHeading(page, "Inbox")
    .locator('.reveal-host a[href*="/s/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))
  return hrefs
    .map((href) => streamIds.find((id) => href.includes(`/s/${id}`)))
    .filter((id): id is string => id !== undefined)
}

interface Seeded {
  workspaceId: string
  testId: string
  other: { page: Page; context: BrowserContext }
}

async function seedWorkspace(page: Page, browser: Browser, prefix: string): Promise<Seeded> {
  const owner = await loginAndCreateWorkspace(page, prefix)
  const workspaceId = page.url().match(/\/w\/([^/?]+)/)![1]
  await enableInboxSection(page, workspaceId)
  const other = await loginInNewContext(
    browser,
    `${prefix}-b-${owner.testId}@example.com`,
    `${prefix} B ${owner.testId}`
  )
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: `${prefix} B ${owner.testId}` },
    }),
    "Second user joins workspace"
  )
  return { workspaceId, testId: owner.testId, other }
}

async function createChannelAway(page: Page, workspaceId: string, name: string): Promise<string> {
  await createChannel(page, name)
  const streamId = page.url().match(/\/s\/([^/?]+)/)![1]
  await page.goto(`/w/${workspaceId}/streams`)
  return streamId
}

async function postAsOther(seeded: Seeded, streamId: string, content: string): Promise<void> {
  const { page } = seeded.other
  await expectApiOk(
    await page.request.post(`/api/workspaces/${seeded.workspaceId}/streams/${streamId}/join`, { data: {} }),
    "Second user joins the channel"
  )
  await expectApiOk(
    await page.request.post(`/api/workspaces/${seeded.workspaceId}/messages`, {
      data: { streamId, content: `[${seeded.testId}] ${content}` },
    }),
    "Second user posts"
  )
}

async function openAndAwaitRead(page: Page, row: Locator, workspaceId: string, streamId: string): Promise<void> {
  await row.locator("a").click()
  await expect(page).toHaveURL(new RegExp(`/s/${streamId}`))
  await expect
    .poll(() => serverUnreadCount(page, workspaceId, streamId), {
      timeout: 15000,
      message: "auto-read should clear the server unread count",
    })
    .toBe(0)
}

test.describe("Inbox clear modes and order", () => {
  test("read mode: reading a stream drops it from the Inbox", async ({ page, browser }) => {
    const seeded = await seedWorkspace(page, browser, "inbox-read")
    await setPreferences(page, seeded.workspaceId, { inboxClearMode: "read" })
    const streamId = await createChannelAway(page, seeded.workspaceId, `inbox-read-${seeded.testId}`)
    await postAsOther(seeded, streamId, "hello")
    await page.reload()

    const inboxRow = sidebarRow(sectionByHeading(page, "Inbox"), streamId)
    await expect(inboxRow).toBeVisible({ timeout: 10000 })
    await openAndAwaitRead(page, inboxRow, seeded.workspaceId, streamId)

    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0, { timeout: 10000 })
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toBeVisible()
    await page.reload()
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toBeVisible({ timeout: 10000 })
    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0)

    await seeded.other.context.close()
  })

  test("interaction mode: replying clears a held stream from the Inbox", async ({ page, browser }) => {
    const seeded = await seedWorkspace(page, browser, "inbox-reply")
    const streamId = await createChannelAway(page, seeded.workspaceId, `inbox-reply-${seeded.testId}`)
    await postAsOther(seeded, streamId, "question for you")
    await page.reload()

    const inboxRow = sidebarRow(sectionByHeading(page, "Inbox"), streamId)
    await expect(inboxRow).toBeVisible({ timeout: 10000 })
    await openAndAwaitRead(page, inboxRow, seeded.workspaceId, streamId)
    await expect.poll(() => isDimmed(inboxRow), { timeout: 10000 }).toBe(true)

    await expectApiOk(
      await page.request.post(`/api/workspaces/${seeded.workspaceId}/messages`, {
        data: { streamId, content: `[${seeded.testId}] answer` },
      }),
      "Owner replies"
    )

    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0, { timeout: 10000 })
    await page.reload()
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toBeVisible({ timeout: 10000 })
    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0)

    await seeded.other.context.close()
  })

  test("order: oldest arrival first by default, newest first when switched", async ({ page, browser }) => {
    const seeded = await seedWorkspace(page, browser, "inbox-order")
    const first = await createChannelAway(page, seeded.workspaceId, `inbox-first-${seeded.testId}`)
    const second = await createChannelAway(page, seeded.workspaceId, `inbox-second-${seeded.testId}`)
    await postAsOther(seeded, first, "arrived first")
    await postAsOther(seeded, second, "arrived second")
    await page.reload()

    await expect.poll(() => inboxOrder(page, [first, second]), { timeout: 10000 }).toEqual([first, second])

    await setPreferences(page, seeded.workspaceId, { inboxOrder: "newest" })
    await page.reload()
    await expect.poll(() => inboxOrder(page, [first, second]), { timeout: 10000 }).toEqual([second, first])

    await seeded.other.context.close()
  })
})
