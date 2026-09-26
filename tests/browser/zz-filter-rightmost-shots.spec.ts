import { test, expect, type Page } from "@playwright/test"
import { devLogin, generateTestId, waitForWorkspaceProvisioned, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 900_000 })
test.use({ actionTimeout: 60_000, navigationTimeout: 120_000 })

const OUT = process.env.SHOTS_DIR ?? "/tmp/filter-shots"

async function api(page: Page, method: "post" | "patch", url: string, data?: unknown): Promise<any> {
  const response = await page.request[method](url, data ? { data } : undefined)
  await expectApiOk(response, `${method} ${url}`)
  return response.json()
}

test("filter rightmost screenshots", async ({ browser, page }) => {
  const t = generateTestId()
  await devLogin(page, `filter-shots-${t}@example.com`, `Filter Shots ${t}`)
  const created = await page.request.post("/api/workspaces", { data: { name: `Filter Shots ${t}` } })
  await expectApiOk(created, "create workspace")
  const ws = ((await created.json()) as { workspace: { id: string } }).workspace.id
  await waitForWorkspaceProvisioned(page, ws)
  const ids: string[] = []
  for (const slug of ["alpha", "bravo", "charlie"]) {
    const json = await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `${slug}-${t}`, visibility: "public" })
    ids.push(json?.stream?.id ?? json?.data?.id ?? json?.id)
  }
  await api(page, "post", `/api/workspaces/${ws}/messages`, { streamId: ids[0], content: "hello" })
  await api(page, "patch", `/api/workspaces/${ws}/sidebar-config`, {
    basePreset: "all",
    sections: [
      { id: "unread", spec: { kind: "unread" } },
      { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
      { id: "channels", spec: { kind: "type", streamType: "channel" } },
      { id: "dms", spec: { kind: "type", streamType: "dm" } },
    ],
  })

  const storageState = await page.context().storageState()
  const desk = await browser.newContext({ storageState, viewport: { width: 1280, height: 1400 } })
  const dp = await desk.newPage()
  await dp.goto(`/w/${ws}/s/${ids[0]}`)
  const nav = dp.getByRole("navigation", { name: "Sidebar navigation" })
  await expect(nav.getByRole("button", { name: "Channels view options" })).toBeAttached({ timeout: 180_000 })
  await dp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 30_000 }).catch(() => {})
  await dp.waitForTimeout(1500)
  // Show every hover-revealed header action at once so their positions compare.
  await dp.addStyleTag({ content: ".reveal-actions { opacity: 1 !important; visibility: visible !important; pointer-events: auto !important; }" })
  await dp.waitForTimeout(300)
  const box = (await nav.boundingBox())!
  const top = (await nav.getByRole("heading", { name: "Inbox" }).boundingBox())!.y - 12
  const bottom = (await nav.getByRole("heading", { name: "Direct messages" }).boundingBox())!.y + 60
  await dp.screenshot({ path: `${OUT}/${process.env.SHOT_TAG ?? "shot"}.png`, clip: { x: box.x, y: top, width: box.width, height: bottom - top } })
})
