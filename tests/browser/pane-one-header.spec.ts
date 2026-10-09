import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * Every pane's header is the pane system's: whatever the pane holds, the first
 * column carries the sidebar toggle, and the trailing edge ends focus, close.
 */

test.describe.configure({ timeout: 120_000 })

async function seed(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await loginAndCreateWorkspace(page, "one-header")
  await createChannel(page, `header-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  await page.getByRole("navigation").getByRole("button", { name: "Collapse sidebar" }).click()
  return { workspaceId, streamId }
}

const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const header = (pane: Locator) => pane.locator("header").first()

async function trailingLabels(pane: Locator): Promise<string[]> {
  const labels = await header(pane)
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? ""))
  return labels.slice(-2)
}

for (const kind of ["context", "compose", "page:search"] as const) {
  test(`should give a ${kind} pane in the first column the sidebar toggle, and end its header with focus and close`, async ({
    page,
  }) => {
    const { workspaceId, streamId } = await seed(page)
    const first = kind === "page:search" ? kind : `${kind}:${streamId}`
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${first}-${streamId}`)

    const pane = tabPane(page, first)
    await expect(header(pane).getByRole("button", { name: "Pin sidebar" })).toBeVisible({ timeout: 30_000 })
    await expect(header(tabPane(page, streamId)).getByRole("button", { name: "Pin sidebar" })).toHaveCount(0)
    expect(await trailingLabels(pane)).toEqual(["Focus pane", "Close"])
    // The stream is the only pane that can hold the route beside a draft or an overview, so only a page frees it to close.
    expect(await trailingLabels(tabPane(page, streamId))).toEqual(
      kind === "page:search" ? ["Focus pane", "Close"] : ["Stream actions", "Focus pane"]
    )
  })
}
