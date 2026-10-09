import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

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
  const from = await at(activity, 0.5, 0.5)
  const to = await at(mainPane(page), 0.95, 0.4)

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  // Chromium coalesces emulated dragovers and can drop the last; a nudge lands one where the pointer rests.
  await page.mouse.move(to.x + 1, to.y)
  await page.mouse.move(to.x, to.y)
  await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "right")
  await page.mouse.up()

  await expect(tabPane(page, "page:activity")).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => params(page))
    .toEqual({ path: `/w/${workspaceId}/s/${streamA}`, panel: "page:activity", m: null })
})
