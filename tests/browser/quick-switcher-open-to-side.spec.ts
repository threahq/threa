import { test, expect, type Page } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"

/**
 * In the installed app, Cmd/Ctrl+Enter in the quick switcher opens the picked
 * stream or page in a pane to the right of the one worked in, and lands focus
 * there; the pane already on show stays where it was.
 */

test.describe.configure({ timeout: 120_000 })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window)
    window.matchMedia = (query: string) =>
      query === "(display-mode: standalone)"
        ? ({ ...matchMedia(query), matches: true, media: query } as MediaQueryList)
        : matchMedia(query)
  })
})

async function seedTwoChannels(page: Page) {
  await loginAndCreateWorkspace(page, "qs-side")
  const workspaceId = workspaceIdFromUrl(page)
  const suffix = Date.now().toString(36)
  const create = async (slug: string) => {
    const res = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "channel", slug, visibility: "public" },
    })
    await expectApiOk(res, `create #${slug}`)
    return ((await res.json()) as { stream: { id: string } }).stream.id
  }
  const streamA = await create(`side-a-${suffix}`)
  const streamB = await create(`side-b-${suffix}`)
  return { workspaceId, streamA, streamB, nameB: `side-b-${suffix}` }
}

const pane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const location = (page: Page) => {
  const url = new URL(page.url())
  return { path: url.pathname, panel: url.searchParams.get("panel") }
}

test("should open a stream to the side with Cmd/Ctrl+Enter and work in it", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamA, streamB, nameB } = await seedTwoChannels(page)

  await page.goto(`/w/${workspaceId}/s/${streamA}`)
  await expect(pane(page, streamA).locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 30_000 })

  await page.keyboard.press("ControlOrMeta+k")
  await expect(page.getByText("Open to the side")).toBeVisible()
  await page.keyboard.type(nameB)
  await expect(page.getByRole("option", { name: new RegExp(`#${nameB}`) }).first()).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Enter")

  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(pane(page, streamB)).toBeVisible()
  await expect(pane(page, streamA)).toBeVisible()
  await expect
    .poll(() => location(page))
    .toEqual({ path: `/w/${workspaceId}/s/${streamB}`, panel: `${streamA}-${streamB}` })
  await expect
    .poll(() => page.evaluate((id) => !!document.activeElement?.closest(`[data-panel-tab="${id}"]`), streamB))
    .toBe(true)
})

test("should open a page command to the side with Cmd/Ctrl+Enter", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamA } = await seedTwoChannels(page)

  await page.goto(`/w/${workspaceId}/s/${streamA}`)
  await expect(pane(page, streamA).locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 30_000 })

  await page.keyboard.press("ControlOrMeta+k")
  await page.keyboard.type("> view activity")
  await expect(page.getByRole("option", { name: /View Activity/ })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+Enter")

  await expect(pane(page, "page:activity").getByRole("heading", { name: "Activity" })).toBeVisible()
  await expect(pane(page, streamA)).toBeVisible()
  await expect.poll(() => location(page)).toEqual({ path: `/w/${workspaceId}/s/${streamA}`, panel: "page:activity" })
})
