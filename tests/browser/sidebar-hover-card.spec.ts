import { test, expect, type Locator, type Page } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace } from "./helpers"

async function post(page: Page, url: string, data: unknown): Promise<string> {
  const response = await page.request.post(url, { data })
  await expectApiOk(response, `POST ${url}`)
  const json = await response.json()
  return json.stream?.id ?? json.message?.id ?? json.data?.id ?? json.id
}

/** True when the element's center is what the pointer would hit there, i.e. it is on screen and not clipped. */
async function isHittable(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return hit !== null && el.contains(hit)
  })
}

test.describe("Sidebar hover card", () => {
  test("should keep the newest message and a fresh reaction in view when the card is height-capped", async ({
    page,
  }) => {
    const { testId } = await loginAndCreateWorkspace(page, "hover-card")
    const workspaceId = page.url().match(/\/w\/([^/?]+)/)![1]
    const streams = `/api/workspaces/${workspaceId}/streams`
    const messages = `/api/workspaces/${workspaceId}/messages`

    const busy = await post(page, streams, { type: "channel", slug: `busy-${testId}`, visibility: "public" })
    const other = await post(page, streams, { type: "channel", slug: `other-${testId}`, visibility: "public" })
    for (let i = 1; i < 8; i++) {
      await post(page, messages, { streamId: busy, content: `Update ${i} runs long enough to wrap across two lines` })
    }
    await post(page, messages, { streamId: busy, content: "Newest update" })
    await post(page, messages, { streamId: other, content: "Elsewhere" })

    await page.setViewportSize({ width: 1280, height: 400 })
    await page.goto(`/w/${workspaceId}/s/${other}`)
    await page.locator(`a[href$='/s/${busy}']`).first().hover()

    const card = page.locator("[data-radix-popper-content-wrapper]").filter({ hasText: `busy-${testId}` })
    const newest = card.getByText("Newest update", { exact: true })
    await expect(newest).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => isHittable(newest)).toBe(true)

    await newest.hover()
    await card.getByRole("button", { name: "Add reaction" }).last().click()
    await page.getByPlaceholder("Search emoji...").fill("fire")
    await page.getByRole("option", { name: ":fire:" }).first().click()

    const pill = card.getByRole("button", { name: /🔥\s*1/ })
    await expect(pill).toBeVisible()
    await expect.poll(() => isHittable(pill)).toBe(true)
  })
})
