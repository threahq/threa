import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * Expand opens a stream's draft as a pane of its own, `compose:<streamId>` in
 * `?panel=`, floating at first. It is the stream's own composer shown there, so
 * the draft carries over both ways; the inline composer becomes a bar until the
 * pane closes, sends, or "Write here" brings the draft back.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function seed(page: Page) {
  await loginAndCreateWorkspace(page, "panel-composer")
  await createChannel(page, `compose-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const parentId = await post(page, workspaceId, streamId, "parent message")
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamId, parentAnchorId: parentId },
  })
  await expectApiOk(response, "create thread")
  const threadId = ((await response.json()) as { stream: { id: string } }).stream.id
  await post(page, workspaceId, threadId, "reply in thread")
  return { workspaceId, streamId, threadId }
}

const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const route = (page: Page) => ({
  stream: new URL(page.url()).pathname.match(/\/s\/([^/]+)/)![1],
  panel: panelParam(page),
})
const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const mainPane = (page: Page) => page.locator('[data-editor-zone="main"]')
const mainComposer = (page: Page) => mainPane(page).locator('[contenteditable="true"]').last()
const paneEditor = (page: Page, streamId: string) =>
  tabPane(page, `compose:${streamId}`).getByRole("textbox", { name: "Expanded message editor" })
const floatingPane = (page: Page) => page.locator("[data-focused-pane]")
const expandLink = (page: Page, within = mainPane(page)) =>
  within.getByRole("link", { name: "Expand editor into a pane" })

test("should carry the draft into a floating pane and back, and close it on send", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { streamId } = await seed(page)
  const compose = `compose:${streamId}`

  await mainComposer(page).click()
  await page.keyboard.type("a long thought")
  await expandLink(page).click()

  await expect.poll(() => panelParam(page)).toBe(`${compose}**`)
  await expect(floatingPane(page)).toHaveAttribute("data-panel-tab", compose)
  await expect(paneEditor(page, streamId)).toHaveText("a long thought")
  await expect(paneEditor(page, streamId)).toBeFocused()
  await expect(tabPane(page, compose).getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
  // The caret lands at the end of the draft.
  await page.keyboard.type(", continued")
  await expect(paneEditor(page, streamId)).toHaveText("a long thought, continued")
  // The inline composer is a bar now, showing the draft it holds the place of.
  await expect(mainPane(page).getByRole("link", { name: "a long thought, continued" })).toBeVisible()
  await expect(mainPane(page).getByRole("textbox")).toHaveCount(0)

  // Escape leaves the editor first, then puts the pane back.
  await page.keyboard.press("Escape")
  await expect(paneEditor(page, streamId)).not.toBeFocused()
  expect(panelParam(page)).toBe(`${compose}**`)
  await page.keyboard.press("Escape")
  await expect.poll(() => panelParam(page)).toBe(compose)
  await expect(floatingPane(page)).toHaveCount(0)
  await expect(paneEditor(page, streamId)).toHaveText("a long thought, continued")

  // Write here closes the pane and brings the draft back inline.
  await mainPane(page).getByRole("button", { name: "Write here" }).click()
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(mainComposer(page)).toHaveText("a long thought, continued")
  await expect(mainComposer(page)).toBeFocused()

  // Sending from the pane clears the draft and closes the pane.
  await expandLink(page).click()
  await expect.poll(() => panelParam(page)).toBe(`${compose}**`)
  await paneEditor(page, streamId).click()
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(mainPane(page).getByText("a long thought, continued", { exact: true })).toBeVisible()
  await expect(mainComposer(page)).toHaveText("")
})

test("should keep a docked draft pane across a reload and toggle it with Alt+Enter", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId } = await seed(page)
  const compose = `compose:${streamId}`

  await mainComposer(page).click()
  await page.keyboard.type("kept")
  await expandLink(page).click()
  await expect(paneEditor(page, streamId)).toHaveText("kept")
  await tabPane(page, compose).getByRole("button", { name: "Restore to layout" }).click()
  await expect.poll(() => panelParam(page)).toBe(compose)

  // The pane's id names no stream the server knows, so nothing fetches it as one.
  const strayFetches: string[] = []
  page.on("request", (request) => {
    if (/\/api\/.*compose(:|%3A)/i.test(request.url())) strayFetches.push(request.url())
  })
  await page.reload()
  await expect(paneEditor(page, streamId)).toHaveText("kept", { timeout: 30_000 })
  expect(strayFetches).toEqual([])
  expect(new URL(page.url()).pathname).toBe(`/w/${workspaceId}/s/${streamId}`)

  await paneEditor(page, streamId).click()
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => panelParam(page)).toBe(`${compose}**`)
  await expect(paneEditor(page, streamId)).toHaveText("kept")
  await paneEditor(page, streamId).click()
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => panelParam(page)).toBe(compose)
  await expect(paneEditor(page, streamId)).toHaveText("kept")
})

test("should open a thread's draft beside it and close it with the thread's tab", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threadId } = await seed(page)
  const compose = `compose:${threadId}`
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)
  await expect(tabPane(page, threadId).getByText("reply in thread", { exact: true })).toBeVisible({ timeout: 30_000 })

  await tabPane(page, threadId).locator('[contenteditable="true"]').last().click()
  await page.keyboard.type("thread draft")
  await expandLink(page, tabPane(page, threadId)).click()
  await expect.poll(() => route(page)).toEqual({ stream: threadId, panel: `${streamId}-${threadId}-${compose}**` })
  await expect(paneEditor(page, threadId)).toHaveText("thread draft")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await expect.poll(() => route(page)).toEqual({ stream: threadId, panel: `${streamId}-${threadId}-${compose}` })
  await expect(tabPane(page, compose).locator("header")).toContainText("Draft to")

  await tabPane(page, threadId).getByRole("button", { name: "Close", exact: true }).click()
  await expect.poll(() => route(page)).toEqual({ stream: streamId, panel: null })
  await expect(tabPane(page, compose)).toHaveCount(0)
})
