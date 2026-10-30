import { test, expect, type Page } from "@playwright/test"
import { ulid } from "ulid"
import { createChannelViaApi, expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"
import { runTestSql } from "./global-setup"

const PREVIEWS = [
  { name: "First linked image", type: "image", url: "https://previews.example.test/first.png" },
  { name: "First website", type: "website", url: "https://previews.example.test/first" },
  { name: "Second linked image", type: "image", url: "https://previews.example.test/second.png" },
  { name: "Second website", type: "website", url: "https://previews.example.test/second" },
  { name: "Third website", type: "website", url: "https://previews.example.test/third" },
] as const

async function seedPreviews(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "preview-defaults")
  const workspaceId = workspaceIdFromUrl(page)
  const streamId = await createChannelViaApi(page, workspaceId, `previews-${testId}`)
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await expect(page.getByRole("heading", { name: `#previews-${testId}`, level: 1 })).toBeVisible({ timeout: 30_000 })

  for (const preview of PREVIEWS) {
    if (preview.type === "image") {
      await page.route(preview.url, (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect width="400" height="160" fill="#427286"/></svg>',
        })
      )
    }
    runTestSql(`
      INSERT INTO link_previews
        (id, workspace_id, url, normalized_url, title, description, content_type, status, fetched_at, expires_at)
      VALUES
        ('lp_${ulid()}', '${workspaceId}', '${preview.url}', '${preview.url}', '${preview.name}',
         'A preview for checking saved display preferences.', '${preview.type}', 'completed', NOW(), NOW() + INTERVAL '1 day')
    `)
  }
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: PREVIEWS.map((preview) => `[${preview.name}](${preview.url})`).join(" ") },
    }),
    "Send mixed preview fixture"
  )
  await expect(page.getByRole("button", { name: "Open image preview: Second linked image" })).toBeVisible({
    timeout: 30_000,
  })
  return workspaceId
}

async function openSettings(page: Page) {
  const url = new URL(page.url())
  url.searchParams.set("settings", "appearance")
  await page.goto(url.toString())
  await expect(page.getByRole("spinbutton", { name: "Default count" })).toBeVisible({ timeout: 30_000 })
}

async function saveCount(page: Page, count: number) {
  const input = page.getByRole("spinbutton", { name: "Default count" })
  await expect(input).toBeEnabled()
  await input.fill(String(count))
  const saved = page.waitForResponse(
    (response) => response.url().endsWith("/preferences") && response.request().method() === "PATCH"
  )
  await input.press("Enter")
  expect((await saved).ok()).toBe(true)
  await expect(input).toBeEnabled()
}

async function closeSettings(page: Page) {
  const url = new URL(page.url())
  url.searchParams.delete("settings")
  await page.goto(url.toString())
  await expect(websiteCard(page, "First linked image")).toBeVisible({ timeout: 30_000 })
}

function websiteCard(page: Page, name: string) {
  return page.locator('[class~="group/preview"]').filter({ has: page.getByText(name, { exact: true }) })
}

for (const mobile of [false, true]) {
  test.describe(mobile ? "Phone preview defaults" : "Desktop preview defaults", () => {
    test.use({ viewport: { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile })
    test("should save arbitrary counts and keep all images plus the first other link expanded", async ({
      page,
    }, testInfo) => {
      test.setTimeout(180_000)
      const workspaceId = await seedPreviews(page)
      if (mobile) await page.setViewportSize({ width: 360, height: 800 })

      await test.step("Persist an arbitrary global count", async () => {
        await openSettings(page)
        await saveCount(page, 7)
        await page.reload()
        await expect(page.getByRole("spinbutton", { name: "Default count" })).toHaveValue("7", { timeout: 30_000 })
      })

      await test.step("Collapse all previews with a zero default", async () => {
        await saveCount(page, 0)
        await closeSettings(page)
        for (const preview of PREVIEWS) {
          const card = websiteCard(page, preview.name)
          await expect(card.locator("button[aria-expanded]").first()).toHaveAttribute("aria-expanded", "false")
        }
      })

      await test.step("Expand all images and the first other link", async () => {
        await openSettings(page)
        await saveCount(page, 1)
        await page.getByRole("combobox", { name: "Images expansion" }).click()
        const saved = page.waitForResponse(
          (response) => response.url().endsWith("/preferences") && response.request().method() === "PATCH"
        )
        await page.getByRole("option", { name: "Expand all", exact: true }).click()
        expect((await saved).ok()).toBe(true)
        await page.reload()
        await expect(page.getByRole("combobox", { name: "Images expansion" })).toHaveText("Expand all", {
          timeout: 30_000,
        })
        await expect(page.getByRole("spinbutton", { name: "Default count" })).toHaveValue("1")
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({
          path: testInfo.outputPath(mobile ? "phone-preview-settings.png" : "desktop-preview-settings.png"),
        })
        await closeSettings(page)

        for (const name of ["First linked image", "Second linked image"]) {
          await expect(page.getByRole("button", { name: `Open image preview: ${name}` })).toBeVisible()
        }
        await expect(websiteCard(page, "First website").locator("button[aria-expanded]").first()).toHaveAttribute(
          "aria-expanded",
          "true"
        )
        const second = websiteCard(page, "Second website").locator("button[aria-expanded]").first()
        await expect(second).toHaveAttribute("aria-expanded", "false")
        await expect(websiteCard(page, "Third website").locator("button[aria-expanded]").first()).toHaveAttribute(
          "aria-expanded",
          "false"
        )
      })

      const second = websiteCard(page, "Second website").locator("button[aria-expanded]").first()
      await test.step("Preserve manual choices after reload and default changes", async () => {
        await second.click()
        await page.reload()
        await expect(second).toHaveAttribute("aria-expanded", "true", { timeout: 30_000 })

        await openSettings(page)
        await saveCount(page, 0)
        await closeSettings(page)
        await expect(websiteCard(page, "First website").locator("button[aria-expanded]").first()).toHaveAttribute(
          "aria-expanded",
          "false"
        )
        await expect(second).toHaveAttribute("aria-expanded", "true")
        await expect(page.getByRole("button", { name: "Open image preview: Second linked image" })).toBeVisible()

        const response = await page.request.get(`/api/workspaces/${workspaceId}/preferences`)
        await expectApiOk(response, "Read saved preview preferences")
        expect((await response.json()).preferences).toMatchObject({
          linkPreviewDefault: "collapsed",
          linkPreviewOpenCount: 1,
          linkPreviewTypeOverrides: { image: "all" },
        })
        await page.screenshot({
          path: testInfo.outputPath(mobile ? "phone-preview-result.png" : "desktop-preview-result.png"),
        })
      })
    })
  })
}
