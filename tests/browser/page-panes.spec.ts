import { test, expect, type Locator, type Page } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"

/**
 * A workspace page opens as a pane (`page:activity`) beside a stream, and a
 * page route keeps the streams beside it. Inside the pane a filter or a search
 * changes it in place without remounting it, a link to a stream takes its tab,
 * and Back undoes that.
 * Its header is any pane's: one row, the tab row standing in for its title.
 * The route moving between the panes on show remounts none of them, and a sidebar
 * pick beside a page takes the place of the pane worked in, as on a stream's page.
 */

test.describe.configure({ timeout: 120_000 })

async function seedTwoChannels(page: Page) {
  await loginAndCreateWorkspace(page, "page-panes")
  const workspaceId = workspaceIdFromUrl(page)
  const suffix = Date.now().toString(36)
  const create = async (slug: string) => {
    const res = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "channel", slug, visibility: "public" },
    })
    await expectApiOk(res, `create #${slug}`)
    return ((await res.json()) as { stream: { id: string } }).stream.id
  }
  const otherId = await create(`pages-b-${suffix}`)
  const streamId = await create(`pages-a-${suffix}`)
  return { workspaceId, streamId, otherId, otherName: `pages-b-${suffix}` }
}

const pane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const pathOf = (page: Page) => new URL(page.url()).pathname
// What a remount would replace: the stream's composer, not the pane's wrapper.
const composerOf = (page: Page, id: string) => pane(page, id).locator('[contenteditable="true"]').first()

async function tag(target: Locator, name: string) {
  await target.evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__paneTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.evaluate((el) => (el as unknown as Record<string, string>).__paneTag ?? null)
}

test("should open a page beside a stream, switch its filter in place without remounting it or the stream, and close it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId } = await seedTwoChannels(page)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=page:activity`)
  const activity = pane(page, "page:activity")
  await expect(activity.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 30_000 })
  await expect(pane(page, streamId)).toBeVisible()
  await tag(composerOf(page, streamId), "stream")
  await tag(activity.getByRole("tablist"), "page")

  await activity.getByRole("tab", { name: "Unread" }).click()
  await expect.poll(() => panelParam(page)).toBe("page:activity/unread")
  expect(pathOf(page)).toBe(`/w/${workspaceId}/s/${streamId}`)
  const unread = pane(page, "page:activity/unread")
  await expect(unread.getByRole("tab", { name: "Unread", selected: true })).toBeVisible()
  expect([await tagOf(unread.getByRole("tablist")), await tagOf(composerOf(page, streamId))]).toEqual([
    "page",
    "stream",
  ])

  await unread.getByRole("button", { name: "Close" }).click()
  await expect.poll(() => panelParam(page)).toBeNull()
  expect(pathOf(page)).toBe(`/w/${workspaceId}/s/${streamId}`)
  expect(await tagOf(composerOf(page, streamId))).toBe("stream")
})

test("should let a stream link in a page pane take its tab, and Back bring the page back", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId, otherId, otherName } = await seedTwoChannels(page)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=page:streams`)
  const streams = pane(page, "page:streams")
  const row = streams.getByRole("link", { name: new RegExp(otherName) })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await tag(composerOf(page, streamId), "stream")

  await row.click()
  await expect(pane(page, otherId)).toBeVisible()
  await expect(streams).toHaveCount(0)
  expect(await tagOf(composerOf(page, streamId))).toBe("stream")

  await page.goBack()
  await expect.poll(() => panelParam(page)).toBe("page:streams")
  await expect(pane(page, "page:streams").getByRole("link", { name: new RegExp(otherName) })).toBeVisible()
  await expect(pane(page, otherId)).toHaveCount(0)
  expect(await tagOf(composerOf(page, streamId))).toBe("stream")
})

test("should search in a page pane in place, the stream beside it untouched", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId } = await seedTwoChannels(page)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=page:search`)
  const field = pane(page, "page:search").getByLabel("Search messages", { exact: true })
  await expect(field).toBeVisible({ timeout: 30_000 })
  await tag(composerOf(page, streamId), "stream")
  await tag(field, "field")

  await field.click()
  await page.keyboard.type("hello")
  // A search query only the pane holds: the URL keeps naming the panes, not the query.
  await expect(pane(page, "page:search").getByText(/\d+ results?/)).toBeVisible()
  expect([pathOf(page), panelParam(page)]).toEqual([`/w/${workspaceId}/s/${streamId}`, "page:search"])
  await expect(field).toHaveText("hello")
  await expect(field).toBeFocused()
  expect([await tagOf(field), await tagOf(composerOf(page, streamId))]).toEqual(["field", "stream"])
})

test("should give a tabbed page pane one header row, its tab row standing in for the title", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId } = await seedTwoChannels(page)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=page:streams.page:activity*`)
  const activity = pane(page, "page:activity")
  await expect(activity.getByRole("tab", { name: "Unread" })).toBeVisible({ timeout: 30_000 })
  const header = activity.locator("header")
  await expect(header).toHaveCount(1)
  await expect(header.getByRole("navigation", { name: "Panel tabs" })).toBeVisible()
  await expect(header.getByRole("tab", { name: "Unread" })).toBeVisible()
  await expect(header.getByRole("heading", { name: "Activity" })).toHaveCount(0)
})

test("should keep a page route's streams beside it and move the route without remounting a pane", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId } = await seedTwoChannels(page)

  await page.goto(`/w/${workspaceId}/activity?panel=${streamId}`)
  const activity = pane(page, "page:activity")
  await expect(activity.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 30_000 })
  await expect(pane(page, streamId)).toBeVisible()
  await tag(composerOf(page, streamId), "stream")
  await tag(activity.getByRole("tablist"), "page")

  // The route's page changes its own path in place, and the panes beside it stay.
  await activity.getByRole("tab", { name: "Me" }).click()
  await expect.poll(() => pathOf(page)).toBe(`/w/${workspaceId}/activity/me`)
  expect(panelParam(page)).toBe(streamId)
  expect([
    await tagOf(pane(page, "page:activity/me").getByRole("tablist")),
    await tagOf(composerOf(page, streamId)),
  ]).toEqual(["page", "stream"])

  // Closing the route's page hands the route to the stream left, which stays mounted.
  await pane(page, "page:activity/me").getByRole("button", { name: "Close" }).click()
  await expect.poll(() => pathOf(page)).toBe(`/w/${workspaceId}/s/${streamId}`)
  expect(panelParam(page)).toBeNull()
  expect(await tagOf(composerOf(page, streamId))).toBe("stream")
})

test("should take the place of the pane worked in for a sidebar pick beside a page, keeping the others mounted", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId, otherId, otherName } = await seedTwoChannels(page)
  const sidebar = page.getByRole("navigation", { name: "Sidebar navigation" })

  await page.goto(`/w/${workspaceId}/activity?panel=${streamId}`)
  const activity = pane(page, "page:activity")
  await expect(activity.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 30_000 })
  await tag(activity.getByRole("tablist"), "page")

  // A stream worked in beside the route's page gives way to the pick; the page stays the route.
  await composerOf(page, streamId).click()
  await sidebar.getByRole("link", { name: `#${otherName}` }).click()
  await expect(composerOf(page, otherId)).toBeVisible()
  expect({ path: pathOf(page), panel: panelParam(page) }).toEqual({
    path: `/w/${workspaceId}/activity`,
    panel: otherId,
  })
  await expect(pane(page, streamId)).toHaveCount(0)
  expect(await tagOf(activity.getByRole("tablist"))).toBe("page")
  await tag(composerOf(page, otherId), "other")

  // The page worked in gives way to a picked stream, which takes the route.
  await activity.getByRole("heading", { name: "Activity" }).click()
  await sidebar.getByRole("link", { name: /^#pages-a-/ }).click()
  await expect.poll(() => pathOf(page)).toBe(`/w/${workspaceId}/s/${streamId}`)
  await expect(composerOf(page, streamId)).toBeVisible()
  await expect(activity).toHaveCount(0)
  expect(await tagOf(composerOf(page, otherId))).toBe("other")
  await tag(composerOf(page, streamId), "stream")

  // A quick link picks a page the same way; the route, following the stream worked in, goes with it to the page.
  await composerOf(page, otherId).click()
  await expect.poll(() => pathOf(page)).toBe(`/w/${workspaceId}/s/${otherId}`)
  await sidebar.getByRole("link", { name: "Activity" }).click()
  await expect(pane(page, "page:activity").getByRole("heading", { name: "Activity" })).toBeVisible()
  await expect(pane(page, otherId)).toHaveCount(0)
  expect({ path: pathOf(page), panel: panelParam(page) }).toEqual({
    path: `/w/${workspaceId}/activity`,
    panel: `${streamId}-page:activity`,
  })
  expect(await tagOf(composerOf(page, streamId))).toBe("stream")
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true })

  test("should let a stream link in a page take its pane, and Back bring the page back", async ({ page }) => {
    const { workspaceId, otherId, otherName } = await seedTwoChannels(page)

    await page.goto(`/w/${workspaceId}/streams`)
    const streams = pane(page, "page:streams")
    await expect(streams.locator("header")).toHaveCount(1)
    await expect(streams.getByRole("link", { name: "Back to workspace" })).toBeVisible({ timeout: 30_000 })

    await streams.getByRole("link", { name: new RegExp(otherName) }).tap()
    await expect.poll(() => pathOf(page)).toBe(`/w/${workspaceId}/s/${otherId}`)
    await expect(composerOf(page, otherId)).toBeVisible()

    await page.goBack()
    await expect.poll(() => pathOf(page)).toBe(`/w/${workspaceId}/streams`)
    await expect(pane(page, "page:streams").getByRole("link", { name: new RegExp(otherName) })).toBeVisible()
  })
})
