import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, panesSettled } from "./helpers"

/**
 * A board card's reply draft opens in a pane of its own (`compose:board:reply:<conversationId>`),
 * in focus or beside the board, as a stream's draft does. The card holds its place with a bar
 * and stays mounted while the feed scrolls it away, since the pane's composer lives in it.
 */

test.describe.configure({ timeout: 120_000 })

const FILLER = Array.from({ length: 6 }, (_, i) => `Filler line ${i + 1} gives the card some height.`).join("\n\n")

async function seedConversations(page: Page, count: number) {
  await loginAndCreateWorkspace(page, "board-draft-panes")
  await createChannel(page, `board-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const post = async (content: string, conversation: Record<string, string>) => {
    const res = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: `${content}\n\n${FILLER}`, conversation },
    })
    await expectApiOk(res, `post ${content}`)
    return (await res.json()) as { conversationId?: string }
  }
  for (let i = 0; i < count; i++) {
    const { conversationId } = await post(`topic ${i} opens`, { intent: "new" })
    if (!conversationId) throw new Error("intent:new returned no conversation id")
    await post(`topic ${i} replies`, { intent: "existing", conversationId })
  }
  return { workspaceId }
}

const board = (page: Page) => page.locator('[data-panel-tab="page:board"]')
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const draftPane = (page: Page) => page.locator('[data-panel-tab^="compose:board:reply:"]')
const paneEditor = (page: Page) => draftPane(page).getByRole("textbox", { name: "Expanded message editor" })
const goToDraft = (page: Page) => board(page).getByRole("button", { name: "Go to draft" })

async function startReply(page: Page, text: string) {
  await board(page).getByRole("button", { name: "Write a reply…" }).first().click()
  await board(page).locator("[contenteditable='true']").first().click()
  await page.keyboard.type(text)
}

test("should write a card's reply in a focused pane, keep the card mounted while the board scrolls, and close the pane on send", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId } = await seedConversations(page, 6)
  await page.goto(`/w/${workspaceId}/board?lens=all`)
  await expect(board(page).getByRole("link", { name: "Open conversation" }).first()).toBeVisible({
    timeout: 30_000,
  })

  await startReply(page, "board draft")
  const expand = board(page).getByRole("link", { name: "Expand editor into a pane" })
  const side = board(page).getByRole("link", { name: "Open to the side" })
  // Links, so they drag into the layout like any pane link.
  const expandHref = (await expand.getAttribute("href"))!
  expect(new URL(expandHref, page.url()).searchParams.get("panel")).toMatch(/^compose:board:reply:[^.]+\*\*$/)
  expect(new URL((await side.getAttribute("href"))!, page.url()).searchParams.get("panel")).toMatch(
    /^compose:board:reply:[^.*]+$/
  )
  await expand.click()

  await expect.poll(() => panelParam(page)).toMatch(/^compose:board:reply:[^.]+\*\*$/)
  await expect(paneEditor(page)).toHaveText("board draft")
  await expect(paneEditor(page)).toBeFocused()
  await expect(goToDraft(page)).toContainText("board draft")

  // Scrolled far past it, the card keeps its composer, which writes in the pane.
  await page.locator("[data-board-scroll-viewport]").evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await expect(board(page).getByText("topic 0 opens", { exact: true })).toBeVisible()
  await expect(paneEditor(page)).toHaveText("board draft")
  await paneEditor(page).click()
  await page.keyboard.type(", continued")
  await expect(paneEditor(page)).toHaveText("board draft, continued")

  await page.keyboard.press("ControlOrMeta+Enter")
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(draftPane(page)).toHaveCount(0)
  await page.locator("[data-board-scroll-viewport]").evaluate((el) => el.scrollTo({ top: 0 }))
  await expect(board(page).getByText("board draft, continued", { exact: true })).toBeVisible()
})

test("should open a card's reply beside the board and bring it back inline with Write here", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId } = await seedConversations(page, 1)
  await page.goto(`/w/${workspaceId}/board?lens=all`)
  await expect(board(page).getByRole("link", { name: "Open conversation" })).toHaveCount(1, { timeout: 30_000 })

  await startReply(page, "beside the board")
  await board(page).getByRole("link", { name: "Expand editor into a pane" }).hover()
  await board(page).getByRole("link", { name: "Open to the side" }).click()

  await expect.poll(() => panelParam(page)).toMatch(/^compose:board:reply:[^.*]+$/)
  await expect(paneEditor(page)).toHaveText("beside the board")
  await expect(page.locator("[data-focused-pane]")).toHaveCount(0)
  await panesSettled(page)
  const [boardBox, paneBox] = [await board(page).boundingBox(), await draftPane(page).boundingBox()]
  expect(paneBox!.x).toBeGreaterThanOrEqual(boardBox!.x + boardBox!.width - 1)
  await expect(draftPane(page).locator("header")).toContainText("Draft")

  await board(page).getByRole("button", { name: "Write here" }).click()
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(board(page).locator("[contenteditable='true']").first()).toHaveText("beside the board")
})
