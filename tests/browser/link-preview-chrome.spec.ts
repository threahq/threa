import { test, expect, type Page } from "@playwright/test"
import type { GitHubPreview, LinearPreview, VideoPreview } from "@threahq/types"
import { ulid } from "ulid"
import { createChannelViaApi, expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"
import { runTestSql } from "./global-setup"

const fetchedAt = "2026-04-08T10:00:00.000Z"
const github: GitHubPreview = {
  type: "github_pr",
  url: "https://github.com/example/preview-demo/pull/42",
  fetchedAt,
  repository: { owner: "example", name: "preview-demo", fullName: "example/preview-demo", private: false },
  data: {
    title: "Make previews useful at a glance",
    number: 42,
    state: "open",
    author: { login: "casey", avatarUrl: null },
    baseBranch: "main",
    headBranch: "preview-headers",
    additions: 120,
    deletions: 30,
    reviewStatusSummary: { approvals: 1, changesRequested: 0, comments: 2, pendingReviewers: 0 },
    createdAt: fetchedAt,
    updatedAt: fetchedAt,
  },
}
const linear: LinearPreview = {
  type: "linear_issue",
  url: "https://linear.app/example/issue/EX-42",
  fetchedAt,
  organization: { id: "example-org", name: "Example team", urlKey: "example" },
  data: {
    identifier: "EX-42",
    title: "Keep issue previews compact",
    summary: "Keep the **important context** visible.",
    state: { name: "In Progress", type: "started", color: "5E6AD2" },
    priority: { label: "High", value: 2 },
    team: { key: "EX", name: "Example" },
    assignee: null,
    labels: [],
    estimate: null,
    dueDate: null,
    projectName: "Preview improvements",
    createdAt: fetchedAt,
    updatedAt: fetchedAt,
  },
}
const video: VideoPreview = {
  type: "video",
  url: "https://preview.example.test/walkthrough",
  provider: "youtube",
  videoId: "abcdef12345",
  embedUrl: "https://www.youtube-nocookie.com/embed/abcdef12345",
  posterUrl: null,
  aspectRatio: 16 / 9,
  title: "A short product walkthrough",
  authorName: "Example studio",
  fetchedAt,
}
const fixtures = {
  pullRequest: { title: "Make previews useful at a glance", url: github.url, contentType: "website", data: github },
  linearIssue: { title: "Keep issue previews compact", url: linear.url, contentType: "website", data: linear },
  article: {
    title: "Notes on clear interfaces",
    url: "https://preview.example.test/article",
    contentType: "website",
    data: null,
  },
  pdf: { title: "Design notes.pdf", url: "https://preview.example.test/notes.pdf", contentType: "pdf", data: null },
  video: { title: "A short product walkthrough", url: video.url, contentType: "website", data: video },
}

function card(page: Page, title: string) {
  return page.locator('[class~="group/preview"]').filter({ has: page.getByText(title, { exact: true }) })
}

async function seed(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "preview-chrome")
  const workspaceId = workspaceIdFromUrl(page)
  const streamId = await createChannelViaApi(page, workspaceId, `chrome-${testId}`)
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await expect(page.getByRole("heading", { name: `#chrome-${testId}`, level: 1 })).toBeVisible({ timeout: 30_000 })
  await expectApiOk(
    await page.request.patch(`/api/workspaces/${workspaceId}/preferences`, {
      data: { linkPreviewDefault: "collapsed", theme: "light" },
    }),
    "Start all previews collapsed"
  )

  for (const fixture of Object.values(fixtures)) {
    const data = fixture.data ? `'${JSON.stringify(fixture.data).replaceAll("'", "''")}'::jsonb` : "NULL"
    const type = fixture.data ? `'${fixture.data.type}'` : "NULL"
    runTestSql(`
      INSERT INTO link_previews
        (id, workspace_id, url, normalized_url, title, description, favicon_url, site_name,
         content_type, preview_type, preview_data, status, fetched_at, expires_at)
      VALUES
        ('lp_${ulid()}', '${workspaceId}', '${fixture.url}', '${fixture.url}', '${fixture.title}',
         'A **clear first line** with useful context.', 'https://preview.example.test/favicon.svg', 'Example',
         '${fixture.contentType}', ${type}, ${data}, 'completed', NOW(), NOW() + INTERVAL '1 day')
    `)
  }
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: {
        streamId,
        content: Object.values(fixtures)
          .map((fixture) => `[${fixture.title}](${fixture.url})`)
          .join(" "),
      },
    }),
    "Send representative preview types"
  )
  await expect(card(page, fixtures.pullRequest.title)).toBeVisible({ timeout: 30_000 })
  return workspaceId
}

for (const mobile of [false, true]) {
  test.describe(mobile ? "Phone preview chrome" : "Desktop preview chrome", () => {
    test.use({ viewport: { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile })
    test("should keep collapsed previews compact and preserve expanded details", async ({
      page,
      context,
    }, testInfo) => {
      test.setTimeout(120_000)
      let failFavicon!: () => void
      const faviconFailure = new Promise<void>((resolve) => {
        failFavicon = resolve
      })
      await page.route("https://preview.example.test/favicon.svg", async (route) => {
        await faviconFailure
        await route.abort()
      })
      await context.route(github.url, (route) =>
        route.fulfill({ contentType: "text/html", body: "<p>Linked pull request</p>" })
      )
      const workspaceId = await seed(page)
      if (mobile) await page.setViewportSize({ width: 360, height: 800 })

      const pr = card(page, fixtures.pullRequest.title)
      const toggle = pr.getByRole("button", { name: /Expand preview/ })
      await expect(toggle).toHaveAttribute("aria-expanded", "false")
      for (const fixture of Object.values(fixtures)) {
        const preview = card(page, fixture.title)
        await expect(preview.getByRole("button", { name: /Expand preview/ })).toHaveAttribute("aria-expanded", "false")
        await expect(preview.getByText(fixture.title, { exact: true })).toBeVisible()
        await expect(preview.getByRole("link")).toHaveCount(0)
        expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(34)
      }

      await pr.scrollIntoViewIfNeeded()
      const before = await pr.boundingBox()
      failFavicon()
      await expect(pr.locator('img[src="https://preview.example.test/favicon.svg"]')).toHaveCount(0)
      const after = await pr.boundingBox()
      expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1)
      expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)

      await toggle.focus()
      await page.keyboard.press("Enter")
      const collapse = pr.getByRole("button", { name: /Collapse preview/ })
      await expect(collapse).toHaveAttribute("aria-expanded", "true")
      await expect(pr.getByText(fixtures.pullRequest.title, { exact: true })).toHaveCount(1)
      await expect(pr).toContainText("#42")
      await expect(pr).toContainText("preview-headers")
      await expect(pr).toContainText("+120")
      await expect(pr).toContainText("1 approved")
      const popupPromise = page.waitForEvent("popup")
      await pr.getByRole("link", { name: fixtures.pullRequest.title, exact: true }).click()
      const popup = await popupPromise
      await expect(popup).toHaveURL(github.url)
      await popup.close()
      await expect(collapse).toHaveAttribute("aria-expanded", "true")
      await page.screenshot({
        path: testInfo.outputPath(`${mobile ? "phone" : "desktop"}-compact-preview-expanded.png`),
      })
      await collapse.click()
      await expect(toggle).toHaveAttribute("aria-expanded", "false")

      for (const fixture of Object.values(fixtures)) {
        const preview = card(page, fixture.title)
        await preview.getByRole("button", { name: /Expand preview/ }).click()
        await expect(preview.getByRole("link", { name: fixture.title, exact: true })).toHaveAttribute(
          "href",
          fixture.url
        )
        await expect(preview.getByText(fixture.title, { exact: true })).toHaveCount(1)
        if (fixture === fixtures.linearIssue) {
          await expect(preview).toContainText("EX-42")
          await expect(preview).toContainText("In Progress")
        }
        await preview.getByRole("button", { name: /Collapse preview/ }).click()
      }

      for (const theme of ["light", "dark"]) {
        await expectApiOk(
          await page.request.patch(`/api/workspaces/${workspaceId}/preferences`, { data: { theme } }),
          "Set preview theme"
        )
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/)
        else await expect(page.locator("html")).not.toHaveClass(/dark/)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        for (const fixture of Object.values(fixtures)) {
          expect((await card(page, fixture.title).boundingBox())!.height).toBeLessThanOrEqual(34)
        }
        await pr.scrollIntoViewIfNeeded()
        await page.screenshot({
          path: testInfo.outputPath(`${mobile ? "phone" : "desktop"}-compact-previews-${theme}.png`),
        })
      }
    })
  })
}
