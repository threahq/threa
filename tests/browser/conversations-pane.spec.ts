import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, generateTestId } from "./helpers"

/**
 * A stream's conversations list is a pane of its own (`convs:<streamId>`) beside
 * the stream it lists. A conversation opened from it lands beside the list, a
 * message link keeps the layout, and the list closes with its stream.
 *
 * The stub boundary extractor gives every channel message its own
 * conversation, with the message's first sentence as topic.
 */

test.describe.configure({ timeout: 120_000 })

async function postMessage(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function seedChannel(page: Page, prefix: string) {
  const testId = generateTestId()
  await createChannel(page, `${prefix}-${testId}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()
  const topic = `Planera offsite ${testId}`
  const messageId = await postMessage(page, workspaceId!, streamId!, `${topic}. Vi behover boka lokal snart.`)
  return { workspaceId: workspaceId!, streamId: streamId!, topic, messageId }
}

const list = (page: Page) => page.getByRole("region", { name: "Conversations", exact: true })
const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")

test("should open the list beside its channel, a conversation beside the list, and restore both on reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await loginAndCreateWorkspace(page, "convs-pane")
  const { workspaceId, streamId, topic, messageId } = await seedChannel(page, "convs")
  await page.goto(`/w/${workspaceId}/s/${streamId}`)

  await page.getByRole("button", { name: "Other conversation views" }).click()
  await page.getByRole("menuitem", { name: "Conversations list" }).click()
  await expect.poll(() => panelParam(page)).toBe(`convs:${streamId}`)
  await expect(list(page).getByText(topic).first()).toBeVisible({ timeout: 30_000 })

  // Beside, not over: once the list has slid in, the timeline ends where it begins.
  await expect
    .poll(async () => {
      const main = await page.locator('[data-editor-zone="main"]').first().boundingBox()
      const pane = await list(page).boundingBox()
      return main!.x + main!.width - pane!.x
    })
    .toBeLessThanOrEqual(1)

  await list(page).getByRole("button", { name: "Open conversation in panel" }).first().click()
  await expect.poll(() => panelParam(page)).toMatch(new RegExp(`convs:${streamId}.*conv:`))
  await expect(list(page)).toBeVisible()

  await page.reload()
  await expect(list(page).getByText(topic).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-panel-tab^="conv:"]')).toBeVisible()

  // A message link inside the list jumps the channel and keeps the list open.
  await list(page).getByText(topic).first().click()
  await list(page).locator(`a[href*="m=${messageId}"]`).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("m")).toBe(messageId)
  expect(panelParam(page)).toContain(`convs:${streamId}`)
  await expect(list(page)).toBeVisible()

  // Back walks it all back: the jump, the expanded row, the conversation, then the list.
  const param = (name: string) => new URL(page.url()).searchParams.get(name)
  await page.goBack()
  await expect.poll(() => param("m")).toBeNull()
  expect(param("conv")).not.toBeNull()
  await page.goBack()
  await expect.poll(() => param("conv")).toBeNull()
  await page.goBack()
  await expect.poll(() => panelParam(page)).toBe(`convs:${streamId}`)
  await page.goBack()
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(list(page)).toHaveCount(0)
})

test("should open the list from a channel pane outside the first column and close it with that channel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await loginAndCreateWorkspace(page, "convs-side")
  const first = await seedChannel(page, "convs-a")
  const second = await seedChannel(page, "convs-b")
  await page.goto(`/w/${first.workspaceId}/s/${first.streamId}?panel=${second.streamId}`)

  await tabPane(page, second.streamId).getByRole("button", { name: "Conversations list" }).click()
  await expect.poll(() => panelParam(page)).toContain(`convs:${second.streamId}`)
  await expect(list(page).getByText(second.topic).first()).toBeVisible({ timeout: 30_000 })
  await expect(list(page).getByText(first.topic)).toHaveCount(0)

  // A jump loaded with the list newest lands in the list's channel, which clears `?m` once it has.
  const jump = new URL(page.url())
  jump.searchParams.set("m", second.messageId)
  await page.goto(jump.toString())
  await expect(tabPane(page, second.streamId).locator(".animate-highlight-flash")).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => new URL(page.url()).searchParams.get("m"), { timeout: 15_000 }).toBeNull()

  await tabPane(page, second.streamId).getByRole("button", { name: "Close tab" }).first().click()
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(list(page)).toHaveCount(0)
})

test("phone: the list is a pane of its own, and Back returns to the channel", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await loginAndCreateWorkspace(page, "convs-phone")
  const { workspaceId, streamId, topic } = await seedChannel(page, "convs-phone")

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await page.locator("header").getByRole("button", { name: "Stream actions" }).click()
  await page.getByRole("button", { name: /Conversations list/ }).click()
  await expect(list(page).getByText(topic).first()).toBeVisible({ timeout: 30_000 })
  await expect(list(page).getByRole("button", { name: "2 open panes" })).toBeVisible()
  await expect(page.locator('[data-editor-zone="main"]').getByText(topic)).not.toBeVisible()

  await list(page).getByRole("button", { name: "Back" }).click()
  await expect(list(page)).toHaveCount(0)
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(page.locator('[data-editor-zone="main"]').getByText(topic)).toBeVisible()
})
