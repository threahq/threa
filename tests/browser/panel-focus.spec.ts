import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * Focus floats a tab's pane over the page, marked `**` in `?panel=`, while a
 * ghost holds its cell. It is the same pane, so its draft and scroll survive;
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
const floatingPane = (page: Page) => page.locator("[data-focused-pane]")
const scrim = (page: Page) => page.getByTestId("pane-focus-scrim")
const ghost = (page: Page) => page.getByTestId("pane-focus-ghost")
const mainPane = (page: Page) => page.locator('[data-editor-zone="main"]')
const inertMain = (page: Page) => page.locator('[inert]:has([data-editor-zone="main"])')

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

  await expect.poll(() => panelParam(page)).toBe(`${a}--${b}**`)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", b)
  await expect(composer(page, b)).toHaveText("half a thought")
  // It floats over the main view too, inset from the page's edges, below the tab bars along the top.
  const floating = (await floatingPane(page).boundingBox())!
  expect(floating.x).toBeLessThan(main.x + main.width / 2)
  expect(floating.x + floating.width).toBeGreaterThan(before.x + before.width - 30)
  expect(floating.y).toBeLessThan(before.y)
  expect(floating.y).toBeGreaterThanOrEqual(main.y)
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
  expect(panelParam(page)).toBe(`${a}--${b}**`)
  // Out of it, Escape puts the pane back.
  await tabPane(page, b).getByText("reply in thread 2", { exact: true }).click()
  await page.keyboard.press("Escape")
  await expect.poll(() => panelParam(page)).toBe(`${a}--${b}`)
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

  // The overview it opens floats above it and keeps its own Escape.
  await tabPane(page, a).getByRole("button", { name: "In this stream" }).click()
  const overview = page.getByRole("complementary", { name: "In this stream" })
  await expect(overview).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(overview).toHaveCount(0)
  expect(panelParam(page)).toBe(`${a}**.${b}`)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a)

  await scrim(page).click({ position: { x: 6, y: 300 } })
  await expect.poll(() => panelParam(page)).toBe(`${a}*.${b}`)
  await expect(floatingPane(page)).toHaveCount(0, { timeout: 15_000 })

  await tabPane(page, a).getByRole("button", { name: "Focus pane", exact: true }).click()
  await expect.poll(() => panelParam(page)).toBe(`${a}**.${b}`)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", a)
  await tabPane(page, a).getByRole("navigation", { name: "Panel tabs" }).locator('[aria-current="page"]').click()
  await expect.poll(() => panelParam(page)).toBe(`${a}*.${b}`)
  await expect(floatingPane(page)).toHaveCount(0)
})

test("should toggle focus with Alt+Enter from the composer without sending", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [a, b] = threads
  await openPanels(page, workspaceId, streamId, `${a}-${b}`, 2)

  await composer(page, a).click()
  await page.keyboard.type("not yet")
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => panelParam(page)).toBe(`${a}**-${b}`)
  await expect(composer(page, a)).toHaveText("not yet")

  await composer(page, a).click()
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => panelParam(page)).toBe(`${a}-${b}`)
  // No new line was typed and nothing was sent.
  await expect(composer(page, a).locator("p")).toHaveCount(1)
  await expect(composer(page, a)).toHaveText("not yet")
  await expect(tabPane(page, a).getByText("not yet", { exact: true })).toHaveCount(1)
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
