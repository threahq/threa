import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, getPanelEditor } from "./helpers"

/**
 * The stream page lays its timeline and thread panel out as flat panes of one
 * grid, so opening, closing, and crossing the phone breakpoint restyle them in
 * place. Every DOM node a reader can lose state in — the timeline scroller, the
 * thread's scroller, the thread's half-typed reply — must be the same node
 * afterwards. Nodes are tagged with an expando: a remount drops it.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

const scroller = (page: Page, streamId: string) => page.locator(`[data-stream-scroller="${streamId}"]`)

async function seedStreamWithThread(page: Page) {
  await loginAndCreateWorkspace(page, "pane-host")
  await createChannel(page, `panes-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const ids: string[] = []
  for (let i = 0; i < 40; i++) {
    ids.push(
      await post(page, workspaceId, streamId, `filler ${String(i).padStart(2, "0")} gives the timeline a scroll`)
    )
  }
  // Mid-stream, so a reader can sit on it away from the tail.
  const parentId = ids[20]
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamId, parentAnchorId: parentId },
  })
  await expectApiOk(response, "create thread")
  const threadId = ((await response.json()) as { stream: { id: string } }).stream.id
  await post(page, workspaceId, threadId, "a reply in the thread")
  await page.reload()
  // A cold load of a 40-message stream can take a while on a busy runner.
  await expect(scroller(page, streamId)).toBeVisible({ timeout: 30_000 })
  return { streamId, threadId, parentId }
}
const parentRow = (page: Page, parentId: string) =>
  page.locator(`[data-editor-zone="main"] [data-message-id="${parentId}"]`).first()
const threadReply = (page: Page, threadId: string) =>
  page.locator(`[data-panel-tab="${threadId}"]`).getByText("a reply in the thread")
const panelHandle = (page: Page) => page.getByRole("separator", { name: "Resize thread panel" })

async function tag(target: Locator, name: string) {
  await target.first().evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__paneTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.first().evaluate((el) => (el as unknown as Record<string, string>).__paneTag ?? null)
}

/** Scroll the timeline up until the mid-stream parent renders, then center it. */
async function revealParent(page: Page, streamId: string, parentId: string) {
  await expect
    .poll(async () => {
      if ((await parentRow(page, parentId).count()) > 0) return true
      await scroller(page, streamId).evaluate((el) => el.scrollBy(0, -400))
      return false
    })
    .toBe(true)
  await parentRow(page, parentId).evaluate((el) => el.scrollIntoView({ block: "center" }))
}

async function openThread(page: Page, parentId: string, threadId: string) {
  await parentRow(page, parentId)
    .getByRole("link", { name: /1 reply/i })
    .click()
  await expect(threadReply(page, threadId)).toBeVisible()
}

test("should keep the timeline and thread panel mounted through open, close and the phone breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { streamId, threadId, parentId } = await seedStreamWithThread(page)
  await tag(scroller(page, streamId), "main")
  await revealParent(page, streamId, parentId)

  // Desktop: the panel docks beside the timeline at its default width.
  await openThread(page, parentId, threadId)
  await expect.poll(async () => Math.round((await page.getByTestId("panel").boundingBox())?.width ?? 0)).toBe(480)
  const main = (await page.locator('[data-editor-zone="main"]').boundingBox())!
  const panel = (await page.getByTestId("panel").boundingBox())!
  expect(Math.round(main.x + main.width)).toBe(Math.round(panel.x))
  await tag(threadReply(page, threadId), "thread")
  await getPanelEditor(page).click()
  await page.keyboard.type("half a thought")

  // Phone: the panel takes the whole content area over the timeline, which
  // stays mounted underneath and out of reach.
  await page.setViewportSize({ width: 400, height: 800 })
  await expect.poll(async () => Math.round((await page.getByTestId("panel").boundingBox())?.width ?? 0)).toBe(400)
  await expect(scroller(page, streamId)).not.toBeVisible()
  expect(await tagOf(threadReply(page, threadId))).toBe("thread")
  expect(await tagOf(scroller(page, streamId))).toBe("main")
  await expect(getPanelEditor(page)).toContainText("half a thought")

  // Back to desktop: same nodes, same draft.
  await page.setViewportSize({ width: 1400, height: 900 })
  await expect.poll(async () => Math.round((await page.getByTestId("panel").boundingBox())?.width ?? 0)).toBe(480)
  expect(await tagOf(threadReply(page, threadId))).toBe("thread")
  expect(await tagOf(scroller(page, streamId))).toBe("main")
  await expect(getPanelEditor(page)).toContainText("half a thought")

  // Closing animates the column away, then unmounts the thread; the timeline stays.
  await page.goBack()
  await expect(threadReply(page, threadId)).toHaveCount(0)
  await expect
    .poll(async () => {
      const box = await page.getByTestId("main-pane").boundingBox()
      return Math.round((box?.x ?? 0) + (box?.width ?? 0))
    })
    .toBe(1400)
  // The column's own transition end is what takes the handle away.
  await expect(panelHandle(page)).toHaveCount(0)
  expect(await tagOf(scroller(page, streamId))).toBe("main")
  await expect(scroller(page, streamId)).toBeVisible()
})

test("should return a phone reader to the same mid-stream position after stepping back from a thread", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 800 })
  const { streamId, threadId, parentId } = await seedStreamWithThread(page)
  // Where the parent sits in the timeline's viewport: the thread takes the stream's place, so Back remounts it.
  const parentTop = () =>
    parentRow(page, parentId).evaluate((el) =>
      Math.round(el.getBoundingClientRect().top - el.closest("[data-stream-scroller]")!.getBoundingClientRect().top)
    )
  const fromBottom = () =>
    scroller(page, streamId).evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))
  // Read from mid-stream: a stick-to-bottom landing on the way back would land at the tail.
  await revealParent(page, streamId, parentId)
  // The load and the jump settle over several frames; sample once it holds still.
  let before = Number.NaN
  await expect
    .poll(async () => {
      const previous = before
      before = await parentTop()
      return before === previous
    })
    .toBe(true)
  expect(await fromBottom()).toBeGreaterThan(200)

  await openThread(page, parentId, threadId)
  await expect(scroller(page, streamId)).not.toBeVisible()

  await page.goBack()
  await expect(scroller(page, streamId)).toBeVisible()
  await expect.poll(parentTop).toBe(before)
  const mainHit = await page.evaluate(() => {
    const el = document.elementFromPoint(200, 400)
    return el?.closest('[data-editor-zone="main"]') !== null
  })
  expect(mainHit).toBe(true)

  // A phone close has no transition to end, so nothing of the thread is left
  // for the desktop layout to show in its empty column.
  await page.setViewportSize({ width: 1400, height: 900 })
  await expect(scroller(page, streamId)).toBeVisible()
  await expect(panelHandle(page)).toHaveCount(0)
})
