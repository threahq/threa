import { test, expect } from "@playwright/test"
import {
  createChannelViaApi,
  createDocViaApi,
  loginAndCreateWorkspace,
  openChannel,
  pane,
  panesSettled,
  renameDoc,
  workspaceIdFromUrl,
} from "./helpers"

/**
 * A doc created in a channel is one of that channel's artifacts: "In this stream" lists it under its own
 * filter with its current title, and the row opens the doc in a pane beside the overview.
 */

test.describe.configure({ timeout: 120_000 })

test("should list a doc created in a channel in its overview and open it beside", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { testId } = await loginAndCreateWorkspace(page, "context-docs")
  const workspaceId = workspaceIdFromUrl(page)
  const channelId = await createChannelViaApi(page, workspaceId, `context-docs-${testId}`)
  const docId = await createDocViaApi(page, workspaceId, channelId)
  const title = `Roadmap ${testId}`
  await renameDoc(page, workspaceId, docId, title)

  await openChannel(page, workspaceId, channelId)
  await page.locator("header").getByRole("button", { name: "In this stream" }).click()
  const overview = page.getByRole("region", { name: "In this stream" })
  await overview.getByRole("button", { name: /^Docs/ }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBe(`context:${channelId}:doc`)

  await overview.getByRole("link", { name: `Open doc ${title}` }).click()
  await expect(pane(page, docId).getByRole("textbox", { name: "Doc title" })).toHaveValue(title, { timeout: 15000 })
  await expect(overview).toBeVisible()

  await panesSettled(page)
  const overviewBox = await overview.boundingBox()
  const docBox = await pane(page, docId).boundingBox()
  expect(overviewBox!.x + overviewBox!.width).toBeLessThanOrEqual(docBox!.x + 1)
})
