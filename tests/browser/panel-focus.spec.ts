import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk } from "./helpers"

/**
 * Focus floats a tab's pane over the page, marked `**` in `?panel=`, while a
 * ghost holds its cell. A pane opened from inside focus joins it, floating
 * beside the rest and taking no cell until focus ends. It is the same pane, so its draft and scroll survive;
 * Escape, the scrim, the tab itself or ⌥Enter put it back, and a phone, which
 * shows one pane at a time, ignores the mark.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function seedThreads(page: Page, count: number) {
  await loginAndCreateWorkspace(page, "panel-focus")
  await createChannel(page, `focus-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const threads: string[] = []
  for (let index = 0; index < count; index++) {
    const parentId = await post(page, workspaceId, streamId, `parent number ${index + 1}`)
    const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "thread", parentStreamId: streamId, parentAnchorId: parentId },
    })
    await expectApiOk(response, "create thread")
    const threadId = ((await response.json()) as { stream: { id: string } }).stream.id
    await post(page, workspaceId, threadId, `reply in thread ${index + 1}`)
    threads.push(threadId)
  }
  return { workspaceId, streamId, threads }
}

const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const composer = (page: Page, id: string) => tabPane(page, id).locator('[contenteditable="true"]').last()
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const route = (page: Page) => ({
  stream: new URL(page.url()).pathname.match(/\/s\/([^/]+)/)![1],
  panel: panelParam(page),
})
const floatingPane = (page: Page) => page.locator("[data-focused-pane]")
const scrim = (page: Page) => page.getByTestId("pane-focus-scrim")
const ghost = (page: Page) => page.getByTestId("pane-focus-ghost")
const mainPane = (page: Page) => page.locator('[data-editor-zone="main"]')
const inertMain = (page: Page) => page.locator('[inert]:has([data-editor-zone="main"])')
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Sidebar navigation" })
const inertSidebar = (page: Page) => page.locator('[inert]:has([aria-label="Sidebar navigation"])')

async function unreadCount(page: Page, workspaceId: string, streamId: string): Promise<number> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(response, "bootstrap")
  return (
    ((await response.json()) as { data: { unreadCounts: Record<string, number> } }).data.unreadCounts[streamId] ?? 0
  )
}

async function openPanels(page: Page, workspaceId: string, streamId: string, panel: string, last: number) {
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${panel}`)
  await expect(page.getByTestId("panel").getByText(`reply in thread ${last}`, { exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

test("should float a tab over the page and put it back, keeping its draft", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  await openPanels(page, workspaceId, streamId, `${a}--${b}`, 2)
  const before = (await tabPane(page, b).boundingBox())!
  const main = (await mainPane(page).boundingBox())!

  await composer(page, b).click()
  await page.keyboard.type("half a thought")
  await tabPane(page, b).getByRole("button", { name: "Focus pane", exact: true }).click()

  await expect.poll(() => route(page)).toEqual({ stream: b, panel: `${streamId}-${a}--${b}**` })
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", b)
  await expect(composer(page, b)).toHaveText("half a thought")
  // It floats over the whole shell, sidebar and headers too, inset from the window's edges.
  const floating = (await floatingPane(page).boundingBox())!
  expect(floating.x).toBeLessThan(main.x)
  expect(floating.x + floating.width).toBeGreaterThan(before.x + before.width - 30)
  expect(floating.y).toBeLessThan(before.y)
  expect(floating.height).toBeGreaterThan(before.height * 1.5)
  await expect(tabPane(page, b).getByText("reply in thread 2", { exact: true })).toBeVisible()
  // A ghost holds its cell, and everything under it is out of reach.
  expect(await ghost(page).boundingBox()).toEqual(before)
  await expect(tabPane(page, a)).toHaveAttribute("inert", "")
  await expect(inertMain(page)).toHaveCount(1)
  await expect(tabPane(page, b).getByRole("button", { name: "Restore to layout" })).toBeVisible()

  // A field keeps its Escape. Restoring moves history, synchronously inside the keydown.
  await composer(page, b).click()
  await page.evaluate(() => {
    const spy = window as unknown as { historyMoves: number }
    spy.historyMoves = 0
    for (const name of ["go", "back", "pushState", "replaceState"] as const) {
      const original = history[name].bind(history) as (...args: unknown[]) => void
      ;(history as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        spy.historyMoves++
        original(...args)
      }
    }
  })
  await page.keyboard.press("Escape")
  expect(await page.evaluate(() => (window as unknown as { historyMoves: number }).historyMoves)).toBe(0)
  expect(route(page)).toEqual({ stream: b, panel: `${streamId}-${a}--${b}**` })
  // Out of it, Escape puts the pane back.
  await tabPane(page, b).getByText("reply in thread 2", { exact: true }).click()
  await page.keyboard.press("Escape")
  await expect.poll(() => route(page)).toEqual({ stream: b, panel: `${streamId}-${a}--${b}` })
  await expect(floatingPane(page)).toHaveCount(0)
  await expect(scrim(page)).toHaveCount(0)
  await expect(ghost(page)).toHaveCount(0)
  await expect(tabPane(page, a)).not.toHaveAttribute("inert")
  await expect(inertMain(page)).toHaveCount(0)
  await expect(composer(page, b)).toHaveText("half a thought")
  expect(await tabPane(page, b).boundingBox()).toEqual(before)

  // Putting it back popped the entry focusing pushed, so Back leaves the page rather than float it again.
  await page.goBack()
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(floatingPane(page)).toHaveCount(0)
})

test("should keep a floating tab across a reload and put it back from the scrim or its tab", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  await openPanels(page, workspaceId, streamId, `${a}**.${b}`, 1)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a)

  await page.reload()
  // The router commits in a transition, which a page still syncing after a reload can hold back for seconds in dev.
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a, { timeout: 15_000 })
  await expect(tabPane(page, a).getByText("reply in thread 1", { exact: true })).toBeVisible({ timeout: 30_000 })

  // Its overview opens floating beside it; working in a makes it the route's stream.
  await tabPane(page, a).getByRole("button", { name: "In this stream" }).click()
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}**.${b}-context:${a}**` })
  await expect(floatingPane(page)).toHaveCount(2)
  await expect(page.getByRole("region", { name: "In this stream" })).toBeVisible()
  await tabPane(page, a).getByRole("button", { name: "In this stream" }).click()
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}**.${b}` })
  await expect(page.getByRole("region", { name: "In this stream" })).toHaveCount(0)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a)

  await scrim(page).click({ position: { x: 6, y: 300 } })
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}*.${b}` })
  await expect(floatingPane(page)).toHaveCount(0, { timeout: 15_000 })

  await tabPane(page, a).getByRole("button", { name: "Focus pane", exact: true }).click()
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}**.${b}` })
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a)
  await tabPane(page, a).getByRole("navigation", { name: "Panel tabs" }).locator('[aria-current="page"]').click()
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}*.${b}` })
  await expect(floatingPane(page)).toHaveCount(0)
})

test("should float a tab over the sidebar, out of its reach, and follow the tab brought forward", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  await openPanels(page, workspaceId, streamId, `${a}**.${b}`, 1)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a)

  const sidebarBox = (await sidebar(page).boundingBox())!
  const floating = (await floatingPane(page).boundingBox())!
  expect(floating.x).toBeLessThan(sidebarBox.x + sidebarBox.width / 2)
  const hits = await page.evaluate(
    ({ x, y }) => {
      const hit = (px: number) => document.elementFromPoint(px, y)
      return {
        overSidebar: hit(x)?.closest("[data-focused-pane]")?.getAttribute("data-panel-tab") ?? null,
        besideFloat: hit(4)?.getAttribute("data-testid") ?? null,
      }
    },
    { x: sidebarBox.x + sidebarBox.width / 2, y: sidebarBox.y + sidebarBox.height / 2 }
  )
  expect(hits).toEqual({ overSidebar: a, besideFloat: "pane-focus-scrim" })
  await expect(inertSidebar(page)).toHaveCount(1)

  // Bringing the other tab of its section forward keeps the float, now on that tab.
  await tabPane(page, a).getByRole("navigation", { name: "Panel tabs" }).locator('a:not([aria-current="page"])').click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}.${b}**`)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", b)
  await expect(tabPane(page, b).getByText("reply in thread 2", { exact: true })).toBeVisible()

  // The scrim over the sidebar puts it back and hands the sidebar back.
  await scrim(page).click({ position: { x: 4, y: sidebarBox.y + sidebarBox.height / 2 } })
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}.${b}`)
  await expect(floatingPane(page)).toHaveCount(0)
  await expect(inertSidebar(page)).toHaveCount(0)
})

test("should float a pane opened from inside focus beside it, out of the grid until focus ends", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  const overview = `context:${a}`
  const overviewButton = tabPane(page, a).getByRole("button", { name: "In this stream" })
  await openPanels(page, workspaceId, streamId, `${a}-${b}`, 2)
  const bBefore = (await tabPane(page, b).boundingBox())!

  await tabPane(page, a).getByRole("button", { name: "Focus pane", exact: true }).click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}**-${b}`)
  // The URL commits before the render does; wait for the float so the click acts on it.
  await expect(floatingPane(page)).toHaveCount(1)
  await overviewButton.click()

  // It joins the group: marked in the URL right of a, floating beside it as a row.
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}**-${b}.${overview}**`)
  await expect(floatingPane(page)).toHaveCount(2)
  await expect(page.getByRole("region", { name: "In this stream" })).toBeVisible()
  const [left, right] = [(await tabPane(page, a).boundingBox())!, (await tabPane(page, overview).boundingBox())!]
  expect(right.x).toBeGreaterThan(left.x + left.width)
  expect(right.y).toBe(left.y)
  expect(Math.abs(right.width - left.width)).toBeLessThan(2)
  // The grid holds no cell for it: b keeps its cell, on show under the scrim, and only a's cell has a ghost.
  expect(await tabPane(page, b).boundingBox()).toEqual(bBefore)
  await expect(tabPane(page, b)).toBeVisible()
  await expect(tabPane(page, b)).toHaveAttribute("inert", "")
  await expect(ghost(page)).toHaveCount(1)

  // Closing a member closes it like any pane, and the rest of the group stays up.
  await overviewButton.click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}**-${b}`)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a)
  await overviewButton.click()
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}**-${b}.${overview}**`)
  await expect(floatingPane(page)).toHaveCount(2)

  // Ending focus moves nothing but the scrim: the overview lands where the URL already had it.
  await tabPane(page, a).getByText("reply in thread 1", { exact: true }).click()
  await page.keyboard.press("Escape")
  await expect.poll(() => panelParam(page)).toBe(`${streamId}-${a}-${b}.${overview}`)
  await expect(floatingPane(page)).toHaveCount(0)
  await expect(ghost(page)).toHaveCount(0)
  await expect(page.getByRole("region", { name: "In this stream" })).toBeVisible()
  await expect.poll(async () => await tabPane(page, overview).boundingBox()).toEqual(bBefore)
})

test("should toggle focus with Alt+Enter from the composer without sending", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  await openPanels(page, workspaceId, streamId, `${a}-${b}`, 2)

  await composer(page, a).click()
  await page.keyboard.type("not yet")
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}**-${b}` })
  await expect(composer(page, a)).toHaveText("not yet")

  await composer(page, a).click()
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}-${b}` })
  // No new line was typed and nothing was sent.
  await expect(composer(page, a).locator("p")).toHaveCount(1)
  await expect(composer(page, a)).toHaveText("not yet")
  await expect(tabPane(page, a).getByText("not yet", { exact: true })).toHaveCount(1)
})

test("should leave what arrives under a floating tab unread until it is put back", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  const other = await loginInNewContext(browser, `focus-b-${Date.now()}@example.com`, "Focus B")
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: "Focus B" },
    }),
    "join workspace"
  )
  await expectApiOk(
    await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
    "join channel"
  )
  await openPanels(page, workspaceId, streamId, `${a}**-${b}`, 1)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a)

  await expect
    .poll(async () => {
      const response = await other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: "arrived under the float" },
      })
      return response.status()
    })
    .toBe(201)
  await expect(mainPane(page).getByText("arrived under the float", { exact: true })).toBeVisible({ timeout: 15_000 })
  // The main view shows through the scrim, but nobody is reading it.
  await page.waitForTimeout(3000)
  expect(await unreadCount(page, workspaceId, streamId)).toBe(1)

  await tabPane(page, a).getByRole("button", { name: "Restore to layout" }).click()
  await expect.poll(() => route(page)).toEqual({ stream: a, panel: `${streamId}-${a}-${b}` })
  await expect.poll(() => unreadCount(page, workspaceId, streamId), { timeout: 15_000 }).toBe(0)
  await other.context.close()
})

test("should leave a phone showing one pane when the URL marks a floating tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  await openPanels(page, workspaceId, streamId, `${a}**.${b}`, 1)

  await expect(floatingPane(page)).toHaveCount(0)
  await expect(scrim(page)).toHaveCount(0)
  await expect(tabPane(page, a).getByRole("button", { name: "Focus pane", exact: true })).toHaveCount(0)
})
