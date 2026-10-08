import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * A sidebar row or a tab dropped on the stream page lands where it was
 * dropped: a pane's edge splits beside it, a tab strip splices between its
 * tabs, and the stream dropped in is the one the route names. The composer
 * keeps its link drop.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string) {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
}

const streamIdOf = (page: Page) => page.url().match(/\/s\/([^/?]+)/)![1]

async function seed(page: Page) {
  await loginAndCreateWorkspace(page, "pane-drops")
  const suffix = Date.now().toString(36)
  const names = { a: `drop-a-${suffix}`, b: `drop-b-${suffix}`, c: `drop-c-${suffix}` }
  await createChannel(page, names.b)
  const streamB = streamIdOf(page)
  await createChannel(page, names.c)
  const streamC = streamIdOf(page)
  await createChannel(page, names.a)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamA = streamIdOf(page)
  await post(page, workspaceId, streamA, "said in a")
  await post(page, workspaceId, streamB, "said in b")
  await post(page, workspaceId, streamC, "said in c")
  await page.reload()
  await expect(page.getByRole("main").getByText("said in a")).toBeVisible({ timeout: 30_000 })
  return { names, streamA, streamB, streamC }
}

const sidebarRow = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Sidebar navigation" }).getByRole("link", { name: `#${name}` })
const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const tabLink = (page: Page, pane: string, id: string) =>
  tabPane(page, pane).getByRole("navigation", { name: "Panel tabs" }).locator(`[data-tab-id="${id}"] a`)
const mainPane = (page: Page) => page.getByTestId("main-pane")
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")

/** A point inside `target`, as shares of its width and height. */
async function at(target: Locator, x: number, y: number) {
  const box = (await target.boundingBox())!
  return { x: box.x + box.width * x, y: box.y + box.height * y }
}

/** `at`, once `target` has stopped moving: a panel slides open. */
async function settledAt(target: Locator, x: number, y: number) {
  let last = ""
  await expect
    .poll(async () => {
      const box = JSON.stringify(await target.boundingBox())
      const still = box === last
      last = box
      return still
    })
    .toBe(true)
  return at(target, x, y)
}

/** Drags `source` to `to` with the mouse; `hovering` runs while it is held there. */
async function drag(page: Page, source: Locator, to: { x: number; y: number }, hovering?: () => Promise<void>) {
  await source.scrollIntoViewIfNeeded()
  const from = await at(source, 0.5, 0.5)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  // Chromium coalesces emulated dragovers and can drop the last; a nudge lands one where the pointer rests.
  await page.mouse.move(to.x + 1, to.y)
  await page.mouse.move(to.x, to.y)
  await hovering?.()
  await page.mouse.up()
}

async function tag(target: Locator, name: string) {
  await target.first().evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__dropTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.first().evaluate((el) => (el as unknown as Record<string, string>).__dropTag ?? null)
}

test("should open, split and splice where a sidebar row or a tab is dropped, without remounting main", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  const { names, streamA, streamB, streamC } = await seed(page)
  await tag(mainPane(page).getByText("said in a"), "main")

  await drag(page, sidebarRow(page, names.b), await at(mainPane(page), 0.95, 0.4), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "right")
  })
  await expect(tabPane(page, streamB).getByText("said in b")).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({
    stream: streamB,
    panel: `${streamA}-${streamB}`,
  })
  await expect(page.getByTestId("pane-drop-indicator")).toHaveCount(0)

  await drag(page, sidebarRow(page, names.c), await settledAt(tabPane(page, streamB), 0.5, 0.8), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "bottom")
  })
  await expect(tabPane(page, streamC).getByText("said in c")).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({
    stream: streamC,
    panel: `${streamA}-${streamB}--${streamC}`,
  })

  // C's tab onto B's strip, ahead of B: one section again, C on show.
  await drag(page, tabLink(page, streamC, streamC), await at(tabLink(page, streamB, streamB), 0.1, 0.5), async () => {
    await expect(tabPane(page, streamB).getByTestId("strip-drop-caret")).toBeVisible()
  })
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${streamC}*.${streamB}`)
  await expect(tabPane(page, streamC).getByText("said in c")).toBeVisible()
  expect(await tagOf(mainPane(page).getByText("said in a"))).toBe("main")

  // The tab on show, past the strip's last tab: to the end. The page's conversation views follow
  // the route, and on C they would fold B's tab away, so work in A first.
  await mainPane(page).locator('[contenteditable="true"]').last().click()
  await expect.poll(() => streamIdOf(page)).toBe(streamA)
  await drag(page, tabLink(page, streamC, streamC), await at(tabLink(page, streamC, streamB), 0.9, 0.5), async () => {
    await expect(tabPane(page, streamC).getByTestId("strip-drop-caret")).toBeVisible()
  })
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: streamC,
      panel: `${streamA}-${streamB}.${streamC}`,
    })

  // Moving a tab rearranges in place; Back undoes the stream dropped in before it.
  await page.goBack()
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: streamB,
      panel: `${streamA}-${streamB}`,
    })
  expect(await tagOf(mainPane(page).getByText("said in a"))).toBe("main")
})

test("should leave a stream or its tab dropped on the composer to the composer, as a link", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  const { names, streamA, streamB, streamC } = await seed(page)
  const editor = mainPane(page).locator("[data-message-composer-root] [contenteditable='true']").first()

  await drag(page, sidebarRow(page, names.c), await at(editor, 0.5, 0.5))
  await expect(editor.locator("[data-type='in-app-link-chip']")).toContainText(names.c)
  expect(panelParam(page)).toBeNull()

  // A stream's tab carries its link the same way; a lone panel shows a title, not tabs, so it takes a second.
  await drag(page, sidebarRow(page, names.b), await at(mainPane(page), 0.95, 0.4))
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${streamB}`)
  await drag(page, sidebarRow(page, names.c), await settledAt(tabPane(page, streamB), 0.5, 0.5), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "centre")
  })
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${streamB}.${streamC}`)
  // Working in A takes the page's conversation views off C, which would fold B's tab away.
  await editor.click()
  await expect.poll(() => panelParam(page)).toBe(`${streamB}.${streamC}`)
  await drag(page, tabLink(page, streamC, streamB), await at(editor, 0.5, 0.5))
  await expect(editor.locator("[data-type='in-app-link-chip']").filter({ hasText: names.b })).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({
    stream: streamA,
    panel: `${streamB}.${streamC}`,
  })
})
