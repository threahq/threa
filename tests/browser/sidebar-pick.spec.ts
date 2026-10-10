import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * A sidebar click on the stream page swaps the pane worked in for the picked
 * stream and closes what was opened from it. Other tabs stay, Back puts the
 * pane back, and the row lit is the pane worked in.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function createThread(page: Page, workspaceId: string, streamId: string, parentId: string, reply: string) {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamId, parentAnchorId: parentId },
  })
  await expectApiOk(response, "create thread")
  const threadId = ((await response.json()) as { stream: { id: string } }).stream.id
  await post(page, workspaceId, threadId, reply)
  return threadId
}

const streamIdOf = (page: Page) => page.url().match(/\/s\/([^/?]+)/)![1]

async function seed(page: Page) {
  await loginAndCreateWorkspace(page, "sidebar-pick")
  const suffix = Date.now().toString(36)
  const names = { a: `pick-a-${suffix}`, b: `pick-b-${suffix}`, c: `pick-c-${suffix}` }
  await createChannel(page, names.b)
  const streamB = streamIdOf(page)
  await post(page, page.url().match(/\/w\/([^/]+)/)![1], streamB, "said in b")
  await createChannel(page, names.c)
  const streamC = streamIdOf(page)
  await createChannel(page, names.a)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamA = streamIdOf(page)
  const parent = await post(page, workspaceId, streamA, "parent in a")
  const thread = await createThread(page, workspaceId, streamA, parent, "reply in a's thread")
  await page.reload()
  await expect(page.getByRole("main").getByText("parent in a")).toBeVisible({ timeout: 30_000 })
  return { workspaceId, names, streamA, streamB, streamC, parent, thread }
}

const sidebarRow = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Sidebar navigation" }).getByRole("link", { name: `#${name}` })
const litRow = (page: Page) =>
  page.getByRole("navigation", { name: "Sidebar navigation" }).locator('a[aria-current="page"]')
const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const mainZone = (page: Page) => page.locator('[data-editor-zone="main"]')

async function tag(target: Locator, name: string) {
  await target.first().evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__pickTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.first().evaluate((el) => (el as unknown as Record<string, string>).__pickTag ?? null)
}

test("should swap the tab worked in for the picked stream, keep main mounted, and put the tab back on Back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { names, streamA, streamB, parent, thread } = await seed(page)
  await tag(mainZone(page).getByText("parent in a"), "main")

  await mainZone(page)
    .locator(`[data-message-id="${parent}"]`)
    .first()
    .getByRole("link", { name: /1 reply/i })
    .click()
  await expect(tabPane(page, thread).getByText("reply in a's thread")).toBeVisible()
  await tabPane(page, thread).getByText("reply in a's thread").click()
  await expect(litRow(page)).toHaveAttribute("href", new RegExp(`/s/${thread}$`))

  await sidebarRow(page, names.b).click()
  await expect(tabPane(page, streamB).getByText("said in b")).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({
    stream: streamB,
    panel: `${streamA}-${streamB}`,
  })
  await expect(tabPane(page, thread)).toHaveCount(0)
  await expect(litRow(page)).toHaveAccessibleName(new RegExp(`#${names.b}`))
  expect(await tagOf(mainZone(page).getByText("parent in a"))).toBe("main")

  await page.goBack()
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${thread}`)
  await expect(tabPane(page, thread).getByText("reply in a's thread")).toBeVisible()
  expect(await tagOf(mainZone(page).getByText("parent in a"))).toBe("main")
})

test("should move main to the picked stream, closing main's thread but keeping an unrelated tab", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { names, streamA, streamB, streamC, parent, thread } = await seed(page)

  // B as a tab of its own: picked while a thread was worked in.
  await mainZone(page)
    .locator(`[data-message-id="${parent}"]`)
    .first()
    .getByRole("link", { name: /1 reply/i })
    .click()
  await tabPane(page, thread).getByText("reply in a's thread").click()
  await sidebarRow(page, names.b).click()
  await expect(tabPane(page, streamB).getByText("said in b")).toBeVisible()

  // A's thread again, from main, beside B.
  await mainZone(page)
    .locator(`[data-message-id="${parent}"]`)
    .first()
    .getByRole("link", { name: /1 reply/i })
    .click()
  await expect(tabPane(page, thread).getByText("reply in a's thread")).toBeVisible()
  expect(
    [streamIdOf(page), ...panelParam(page)!.split(/[-.*]+/)].filter((id, at, ids) => ids.indexOf(id) === at).sort()
  ).toEqual([streamA, streamB, thread].sort())

  // Working in main lights A's row; picking C moves main and closes only A's thread.
  await mainZone(page).getByText("parent in a").click()
  await expect(litRow(page)).toHaveAccessibleName(new RegExp(`#${names.a}`))
  await sidebarRow(page, names.c).click()
  await expect.poll(() => streamIdOf(page)).toBe(streamC)
  expect(panelParam(page)).toBe(streamB)
  await expect(tabPane(page, thread)).toHaveCount(0)
  await expect(litRow(page)).toHaveAccessibleName(new RegExp(`#${names.c}`))

  await page.goBack()
  await expect.poll(() => streamIdOf(page)).toBe(streamA)
  await expect(tabPane(page, thread).getByText("reply in a's thread")).toBeVisible()
})

test("should show main when its stream is picked on a phone, and swap the page in front for any other", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, names, streamA, streamB, streamC } = await seed(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceId}/s/${streamA}?panel=${streamB}`)
  await expect(tabPane(page, streamB).getByText("said in b")).toBeVisible({ timeout: 30_000 })

  const pickOnPhone = async (name: string) => {
    await page.getByRole("button", { name: "Pin sidebar" }).filter({ visible: true }).last().click()
    await expect(
      page.getByRole("navigation", { name: "Sidebar navigation" }).getByLabel("Collapse sidebar")
    ).toBeInViewport()
    await sidebarRow(page, name).click()
  }

  await pickOnPhone(names.a)
  await expect(page.getByRole("main").getByText("parent in a")).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({ stream: streamA, panel: null })
  await expect(tabPane(page, streamB)).toHaveCount(0)

  await page.goBack()
  await expect(tabPane(page, streamB).getByText("said in b")).toBeVisible()
  await pickOnPhone(names.c)
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${streamC}`)
  expect(streamIdOf(page)).toBe(streamC)
  await expect(tabPane(page, streamB)).toHaveCount(0)
})
