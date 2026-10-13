import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, panesSettled } from "./helpers"

/**
 * A link dropped on a pane opens what it names there: a stream, at the message
 * its permalink names, or a workspace page. A link naming neither does nothing.
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

const streamIdOf = (page: Page) => page.url().match(/\/s\/([^/?]+)/)?.[1] ?? null

async function seed(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await loginAndCreateWorkspace(page, "link-drops")
  const suffix = Date.now().toString(36)
  await createChannel(page, `link-b-${suffix}`)
  const streamB = streamIdOf(page)!
  await createChannel(page, `link-a-${suffix}`)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamA = streamIdOf(page)!
  const messageB = await post(page, workspaceId, streamB, "said in b")
  return { workspaceId, streamA, streamB, messageB }
}

const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const mainPane = (page: Page) => page.getByTestId("main-pane")
const params = (page: Page) => {
  const url = new URL(page.url())
  return { path: url.pathname, panel: url.searchParams.get("panel"), m: url.searchParams.get("m") }
}

async function at(target: Locator, x: number, y: number) {
  const box = (await target.boundingBox())!
  return { x: box.x + box.width * x, y: box.y + box.height * y }
}

/**
 * Fires drag events carrying a link the way the browser does for an `<a>`: only
 * `text/uri-list`, which a drop target can see by type but not read until the drop.
 */
const fire = (page: Page, point: { x: number; y: number }, url: string, types: string[]) =>
  page.evaluate(
    ({ point, url, types }) => {
      const holder = window as unknown as { __linkDrag?: DataTransfer }
      if (!holder.__linkDrag) {
        holder.__linkDrag = new DataTransfer()
        holder.__linkDrag.setData("text/uri-list", url)
      }
      const target = document.elementFromPoint(point.x, point.y)!
      for (const type of types) {
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            dataTransfer: holder.__linkDrag,
          })
        )
      }
      if (types.includes("drop")) delete holder.__linkDrag
    },
    { point, url, types }
  )

/** Drags a link to `to` and drops it there. `hovering` runs between the dragover and the drop. */
async function dropLink(page: Page, to: { x: number; y: number }, url: string, hovering?: () => Promise<void>) {
  await fire(page, to, url, ["dragenter", "dragover"])
  await hovering?.()
  await fire(page, to, url, ["dragover", "drop"])
}

/** Drags `link` itself with the pointer and rests it at `to`, the button still down. */
async function dragTo(page: Page, link: Locator, to: { x: number; y: number }) {
  const from = await at(link, 0.5, 0.5)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  // Chromium coalesces emulated dragovers and can drop the last; a nudge lands one where the pointer rests.
  await page.mouse.move(to.x + 1, to.y)
  await page.mouse.move(to.x, to.y)
}

test("should open the stream a dropped permalink names beside the pane, at its message", async ({ page }) => {
  const { workspaceId, streamA, streamB, messageB } = await seed(page)
  const origin = new URL(page.url()).origin

  await dropLink(
    page,
    await at(mainPane(page), 0.95, 0.4),
    `${origin}/w/${workspaceId}/s/${streamB}?m=${messageB}`,
    async () => {
      await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "right")
    }
  )

  await expect(tabPane(page, streamB).getByText("said in b")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => params(page))
    .toEqual({
      path: `/w/${workspaceId}/s/${streamB}`,
      panel: `${streamA}-${streamB}`,
      m: messageB,
    })
  await expect(page.getByTestId("pane-drop-indicator")).toHaveCount(0)
})

test("should open the page a dropped link names as a pane, keeping its query", async ({ page }) => {
  const { workspaceId, streamA } = await seed(page)
  const origin = new URL(page.url()).origin

  await dropLink(page, await at(mainPane(page), 0.95, 0.4), `${origin}/w/${workspaceId}/search?q=hello`)

  await expect(tabPane(page, "page:search").getByLabel("Search messages")).toHaveText("hello", { timeout: 30_000 })
  // A page opened beside a stream leaves the route on the stream.
  await expect
    .poll(() => params(page))
    .toEqual({ path: `/w/${workspaceId}/s/${streamA}`, panel: "page:search", m: null })
})

test("should leave the panes as they are for a dropped link that names no pane", async ({ page }) => {
  const { workspaceId, streamA } = await seed(page)
  const origin = new URL(page.url()).origin

  for (const url of [
    "https://example.com/w/elsewhere",
    `${origin}/w/${workspaceId}/settings`,
    `${origin}/w/ws_other/s/${streamA}`,
  ]) {
    await dropLink(page, await at(mainPane(page), 0.95, 0.4), url)
  }
  // Drops land in order, so once a later one shows, any effect of these would have too.
  await dropLink(page, await at(mainPane(page), 0.95, 0.4), `${origin}/w/${workspaceId}/search?q=after`)

  await expect(tabPane(page, "page:search").getByLabel("Search messages")).toHaveText("after", { timeout: 30_000 })
  await expect
    .poll(() => params(page))
    .toEqual({ path: `/w/${workspaceId}/s/${streamA}`, panel: "page:search", m: null })
  await expect(page.getByTestId("pane-drop-indicator")).toHaveCount(0)
})

test("should leave a link dropped on a pane's text field to the field", async ({ page }) => {
  const { workspaceId, streamA, streamB } = await seed(page)
  const origin = new URL(page.url()).origin
  await page.goto(`/w/${workspaceId}/s/${streamA}?panel=page:streams`)
  const pane = tabPane(page, "page:streams")
  const field = pane.getByRole("searchbox", { name: "Search streams" })
  await expect(field).toBeVisible({ timeout: 30_000 })
  // Visible counts the page still masked for its first reveal, which no event reaches.
  await field.click({ trial: true })
  const link = `${origin}/w/${workspaceId}/s/${streamB}`

  // On its way to the field the drag crosses the pane, which offers to split.
  await fire(page, await at(pane, 0.5, 0.6), link, ["dragenter", "dragover"])
  await expect(page.getByTestId("pane-drop-indicator")).toBeVisible()
  await fire(page, await at(field, 0.5, 0.5), link, ["dragover"])
  await expect(page.getByTestId("pane-drop-indicator")).toHaveCount(0)
  await fire(page, await at(field, 0.5, 0.5), link, ["drop"])
  // Drops land in order, so once a later one shows, any effect of the field's would have too.
  await dropLink(page, await at(mainPane(page), 0.95, 0.4), `${origin}/w/${workspaceId}/search?q=after`)

  await expect(tabPane(page, "page:search").getByLabel("Search messages")).toHaveText("after", { timeout: 30_000 })
  const { path, panel } = params(page)
  expect({ path, opensB: panel?.includes(streamB) }).toEqual({ path: `/w/${workspaceId}/s/${streamA}`, opensB: false })
})

test("should open a workspace page beside the pane when its sidebar link is dragged there", async ({ page }) => {
  const { workspaceId, streamA } = await seed(page)
  const activity = page.getByRole("navigation", { name: "Sidebar navigation" }).getByRole("link", { name: "Activity" })

  await dragTo(page, activity, await at(mainPane(page), 0.95, 0.4))
  await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "right")
  await page.mouse.up()

  await expect(tabPane(page, "page:activity")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => params(page))
    .toEqual({ path: `/w/${workspaceId}/s/${streamA}`, panel: "page:activity", m: null })
})

test("should open the thread and the draft thread a dropped timeline link brings up", async ({ page }) => {
  const { workspaceId, streamA } = await seed(page)
  const origin = new URL(page.url()).origin
  const parent = await post(page, workspaceId, streamA, "has a thread")
  const bare = await post(page, workspaceId, streamA, "has none")
  const thread = await createThread(page, workspaceId, streamA, parent, "said in the thread")
  await page.reload()
  const row = (id: string) => mainPane(page).locator(`[data-message-id="${id}"]`).first()
  const hrefOf = async (link: Locator) => `${origin}${await link.getAttribute("href")}`
  const replies = row(parent).getByRole("link", { name: /1 reply/i })
  await expect(replies).toBeVisible({ timeout: 30_000 })

  await dragTo(page, replies, await at(mainPane(page), 0.95, 0.4))
  await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "right")
  await page.mouse.up()
  await expect(tabPane(page, thread).getByText("said in the thread")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => params(page))
    .toEqual({ path: `/w/${workspaceId}/s/${thread}`, panel: `${streamA}-${thread}`, m: null })

  const draft = `draft:${streamA}:${bare}`
  const reply = row(bare).getByRole("link", { name: "Reply in thread" })
  await expect(reply).toBeAttached()
  await panesSettled(page)
  await dropLink(page, await at(tabPane(page, thread), 0.95, 0.4), await hrefOf(reply))
  await expect(tabPane(page, draft)).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => params(page))
    .toEqual({ path: `/w/${workspaceId}/s/${thread}`, panel: `${streamA}-${thread}-${draft}`, m: null })
})

test("should refuse a dragged link that brings up no pane, over the whole pane", async ({ page }) => {
  const { workspaceId, streamA } = await seed(page)
  await post(page, workspaceId, streamA, "see [the docs](https://example.com/docs)")
  const link = mainPane(page).getByRole("link", { name: "the docs" })
  await expect(link).toBeVisible({ timeout: 30_000 })
  const before = params(page)

  await dragTo(page, link, await at(mainPane(page), 0.95, 0.4))
  await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "refused")
  await page.mouse.up()

  await expect(page.getByTestId("pane-drop-indicator")).toHaveCount(0)
  expect(params(page)).toEqual(before)
})
