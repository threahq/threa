import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk } from "./helpers"

/**
 * Opening a second thread beside the first adds a tab to the panel, kept in
 * `?panel=` so reload and back land on the same arrangement. Tabs stack in one
 * grid cell: the ones behind stay mounted (expando tags survive a switch) and
 * live, but nothing judges them on screen.
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

async function seedTwoThreads(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "panel-tabs")
  await createChannel(page, `tabs-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const parentA = await post(page, workspaceId, streamId, "first parent")
  const parentB = await post(page, workspaceId, streamId, "second parent")
  const threadA = await createThread(page, workspaceId, streamId, parentA, "reply in thread A")
  const threadB = await createThread(page, workspaceId, streamId, parentB, "reply in thread B")
  await page.reload()
  await expect(page.getByRole("main").getByText("second parent")).toBeVisible({ timeout: 30_000 })
  return { testId, workspaceId, streamId, parentA, parentB, threadA, threadB }
}

const tabStrip = (page: Page) => page.getByRole("navigation", { name: "Panel tabs" }).first()
const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const replyIn = (page: Page, id: string, text: string) => tabPane(page, id).getByText(text)
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")

async function openFromTimeline(page: Page, parentId: string) {
  await page
    .locator(`[data-editor-zone="main"] [data-message-id="${parentId}"]`)
    .first()
    .getByRole("link", { name: /1 reply/i })
    .click()
}

async function tag(target: Locator, name: string) {
  await target.first().evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__tabTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.first().evaluate((el) => (el as unknown as Record<string, string>).__tabTag ?? null)
}

test("should open a second thread as a tab that switches, closes on back and survives reload", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { parentA, parentB, threadA, threadB } = await seedTwoThreads(page)

  // One thread reads as it always has: a title, no tab row.
  await openFromTimeline(page, parentA)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  await tag(replyIn(page, threadA, "reply in thread A"), "A")

  // The second opens beside it as a tab and takes the front.
  await openFromTimeline(page, parentB)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  expect(panelParam(page)).toBe(`${threadA}.${threadB}`)
  // Unnamed threads take their parent message's text, so the tabs tell apart.
  await expect(tabStrip(page).getByRole("link")).toHaveText(["first parent", "second parent"])
  await expect(tabStrip(page).locator(`[aria-current="page"]`)).toHaveCount(1)
  await expect(replyIn(page, threadA, "reply in thread A")).not.toBeVisible()
  await tag(replyIn(page, threadB, "reply in thread B"), "B")

  // Switching brings A back without remounting either tab.
  await tabStrip(page).getByRole("link").first().click()
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await expect(replyIn(page, threadB, "reply in thread B")).not.toBeVisible()
  expect(panelParam(page)).toBe(`${threadA}*.${threadB}`)
  expect(await tagOf(replyIn(page, threadA, "reply in thread A"))).toBe("A")
  expect(await tagOf(replyIn(page, threadB, "reply in thread B"))).toBe("B")

  // The switch replaced its entry: back closes the tab B opened, A stays mounted.
  await page.goBack()
  await expect.poll(() => panelParam(page)).toBe(threadA)
  await expect(tabPane(page, threadB)).toHaveCount(0)
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  expect(await tagOf(replyIn(page, threadA, "reply in thread A"))).toBe("A")

  // Forward and reload land on the same arrangement.
  await page.goForward()
  await expect.poll(() => panelParam(page)).toBe(`${threadA}*.${threadB}`)
  await page.reload()
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible({ timeout: 30_000 })
  await expect(tabStrip(page).getByRole("link")).toHaveCount(2)
  await expect(replyIn(page, threadB, "reply in thread B")).not.toBeVisible()
})

test("should pop the history entry when closing the newest tab and replace when closing an older one", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { streamId, parentA, parentB, threadA, threadB } = await seedTwoThreads(page)

  await openFromTimeline(page, parentA)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await openFromTimeline(page, parentB)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()

  // Closing B leaves exactly the entry before it opened, so back closes A next.
  await tabStrip(page).getByRole("button", { name: "Close tab" }).last().click()
  await expect.poll(() => panelParam(page)).toBe(threadA)
  await page.goBack()
  await expect.poll(() => panelParam(page)).toBeNull()
  expect(new URL(page.url()).pathname).toContain(streamId)

  // Closing the older tab rewrites in place: back returns to A alone.
  await openFromTimeline(page, parentA)
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  await openFromTimeline(page, parentB)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
  // Inactive tabs show their close on hover.
  await tabStrip(page).getByRole("link").first().hover()
  await tabStrip(page).getByRole("button", { name: "Close tab" }).first().click()
  await expect.poll(() => panelParam(page)).toBe(threadB)
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  await page.goBack()
  await expect.poll(() => panelParam(page)).toBe(threadA)
})

test("should leave a background tab unread until it comes to the front", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { testId, workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

  const other = await loginInNewContext(browser, `tabs-b-${testId}@example.com`, `Tabs B ${testId}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: `Tabs B ${testId}` },
    }),
    "second user joins workspace"
  )
  await expectApiOk(
    await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
    "second user joins the channel"
  )

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })

  const unread = async () => {
    const res = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
    await expectApiOk(res, "bootstrap")
    const body = (await res.json()) as { data: { unreadCounts: Record<string, number> } }
    return body.data.unreadCounts[threadA] ?? 0
  }

  await expect
    .poll(
      async () =>
        (
          await other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId: threadA, content: "news for the tab behind" },
          })
        ).status(),
      { timeout: 10_000 }
    )
    .toBe(201)

  // The tab behind is live: the message lands in its DOM, out of sight.
  await expect(replyIn(page, threadA, "news for the tab behind")).toBeAttached()
  await expect(replyIn(page, threadA, "news for the tab behind")).not.toBeVisible()
  await expect.poll(unread).toBeGreaterThan(0)
  // Long enough for an auto-read to have fired if anything judged it on screen.
  await page.waitForTimeout(2_000)
  expect(await unread()).toBeGreaterThan(0)

  await tabStrip(page).getByRole("link").first().click()
  await expect(replyIn(page, threadA, "news for the tab behind")).toBeVisible()
  await expect.poll(unread, { timeout: 15_000 }).toBe(0)

  await other.context.close()
})

test("should show the tab row on a phone with the back control and keep both tabs mounted", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 })
  const { workspaceId, streamId, threadA, threadB } = await seedTwoThreads(page)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadA}.${threadB}`)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible({ timeout: 30_000 })
  await tag(replyIn(page, threadB, "reply in thread B"), "B")
  const strip = tabStrip(page)
  await expect(strip.getByRole("link")).toHaveCount(2)
  // The strip fits the phone header without pushing the page sideways.
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scrollWidth).toBeLessThanOrEqual(400)

  await strip.getByRole("link").first().click()
  await expect(replyIn(page, threadA, "reply in thread A")).toBeVisible()
  expect(await tagOf(replyIn(page, threadB, "reply in thread B"))).toBe("B")

  // Back on a phone closes the panel's newest step, not the page.
  await tabPane(page, threadA).getByRole("button", { name: "Back" }).click()
  await expect.poll(() => panelParam(page)).toBe(threadB)
  await expect(replyIn(page, threadB, "reply in thread B")).toBeVisible()
})
