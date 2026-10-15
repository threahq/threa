import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The board is a page pane (`page:board`): a card opens its conversation as a
 * tab beside it, a second card adds a tab, and closing them all leaves the bare
 * board. A phone stacks an opened pane over the board, which stays mounted under it.
 */

test.describe.configure({ timeout: 120_000 })

const FILLER = Array.from({ length: 6 }, (_, i) => `Filler line ${i + 1} gives the card some height.`).join("\n\n")

async function seedConversations(page: Page, count: number) {
  await loginAndCreateWorkspace(page, "board-panes")
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
const openers = (page: Page) => board(page).getByRole("link", { name: "Open conversation" })
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
const boardScrollTop = (page: Page) =>
  page.locator("[data-board-scroll-viewport]").evaluate((el) => Math.round(el.scrollTop))

test("should open two cards as two tabs beside the board and land on the bare board when both close", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId } = await seedConversations(page, 2)
  await page.goto(`/w/${workspaceId}/board?lens=all`)
  await expect(openers(page)).toHaveCount(2, { timeout: 30_000 })

  await openers(page).first().click()
  await expect.poll(() => panelParam(page)).toMatch(/^conv:[^.]+$/)
  const first = panelParam(page)!
  await expect(page.locator(`[data-panel-tab="${first}"]`)).toBeVisible()
  await openers(page).nth(1).click()
  await expect.poll(() => panelParam(page)).toMatch(new RegExp(`^${first}\\.conv:[^.]+$`))
  const second = panelParam(page)!.split(".")[1]

  await expect(board(page)).toBeVisible()
  await expect(page.getByTestId("panel")).toHaveCount(2)
  await expect(page.locator(`[data-panel-tab="${second}"]`)).toBeVisible()
  const tabs = page.getByRole("navigation", { name: "Panel tabs" })
  await expect(tabs.getByRole("link")).toHaveCount(2)
  const boardBox = await board(page).boundingBox()
  const panelBox = await page.locator(`[data-panel-tab="${second}"]`).boundingBox()
  expect(boardBox!.x + boardBox!.width).toBeLessThanOrEqual(panelBox!.x + 1)

  await tabs.getByRole("button", { name: "Close tab" }).last().click()
  await expect.poll(() => panelParam(page)).toBe(first)
  await page.getByTestId("panel").getByRole("button", { name: "Close", exact: true }).click()
  await expect.poll(() => panelParam(page)).toBeNull()
  expect(new URL(page.url()).pathname).toBe(`/w/${workspaceId}/board`)
  await expect(page.getByTestId("panel")).toHaveCount(0)
  await expect(board(page)).toBeVisible()
})

test("should open a card's conversation where its opener is dragged to", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId } = await seedConversations(page, 1)
  await page.goto(`/w/${workspaceId}/board?lens=all`)
  await expect(openers(page)).toHaveCount(1, { timeout: 30_000 })

  const from = (await openers(page).boundingBox())!
  const box = (await board(page).boundingBox())!
  const to = { x: box.x + box.width / 2, y: box.y + box.height * 0.95 }
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  // Chromium coalesces emulated dragovers and can drop the last; a nudge lands one where the pointer rests.
  await page.mouse.move(to.x + 1, to.y)
  await page.mouse.move(to.x, to.y)
  await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "bottom")
  await page.mouse.up()

  // Below the board, in its column.
  await expect.poll(() => panelParam(page)).toMatch(/^page:board--conv:[^.-]+$/)
  const pane = page.locator(`[data-panel-tab="${panelParam(page)!.split("--")[1]}"]`)
  await expect(pane).toBeVisible()
  const [boardBox, paneBox] = [await board(page).boundingBox(), await pane.boundingBox()]
  expect(paneBox!.y).toBeGreaterThanOrEqual(boardBox!.y + boardBox!.height - 1)
})

test("should put an aside's draft in the card's reply field and close the aside when it is sent to the composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId } = await seedConversations(page, 1)
  await page.goto(`/w/${workspaceId}/board?lens=all`)
  await expect(openers(page)).toHaveCount(1, { timeout: 30_000 })

  await board(page).getByRole("button", { name: "Conversation actions" }).click()
  await page.getByRole("menuitem", { name: "Open an aside" }).click()
  const aside = page.getByTestId("aside-panel")
  await expect(aside).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => panelParam(page)).toMatch(/^aside:/)

  await aside.getByRole("button", { name: /drafts?$/i }).click()
  await aside.getByRole("button", { name: "Start a draft" }).click()
  await aside.getByTestId("aside-draft-editor").locator("[contenteditable='true']").click()
  await page.keyboard.type("carried to the card")
  await aside.getByRole("button", { name: "Send to composer" }).first().click()

  await expect(board(page).locator("[contenteditable='true']")).toContainText("carried to the card")
  await expect(aside).toHaveCount(0)
  await expect.poll(() => panelParam(page)).toBeNull()
  expect(new URL(page.url()).pathname).toBe(`/w/${workspaceId}/board`)
  await expect(page.getByTestId("panel")).toHaveCount(0)
})

test("should save the draft a card already holds when an aside's draft is sent to its reply field", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId } = await seedConversations(page, 1)
  await page.goto(`/w/${workspaceId}/board?lens=all`)
  await expect(openers(page)).toHaveCount(1, { timeout: 30_000 })
  const reply = board(page).locator("[contenteditable='true']")
  await board(page).getByRole("button", { name: "Write a reply…" }).click()
  await reply.click()
  await page.keyboard.type("already in the card")

  await board(page).getByRole("button", { name: "Conversation actions" }).click()
  await page.getByRole("menuitem", { name: "Open an aside" }).click()
  const aside = page.getByTestId("aside-panel")
  await expect(aside).toBeVisible({ timeout: 15_000 })
  await aside.getByRole("button", { name: /drafts?$/i }).click()
  await aside.getByRole("button", { name: "Start a draft" }).click()
  await aside.getByTestId("aside-draft-editor").locator("[contenteditable='true']").click()
  await page.keyboard.type("carried to the card")
  await aside.getByRole("button", { name: "Send to composer" }).first().click()

  await expect(reply).toHaveCount(1)
  await expect(reply).toHaveText("carried to the card")
  await expect(aside).toHaveCount(0)
  await board(page).getByRole("button", { name: "Drafts (1 saved)" }).click()
  await expect(page.getByText("already in the card")).toBeVisible()
})

test("should move keyboard focus onto the board and float it like any page when the pane shortcuts reach it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId } = await seedConversations(page, 1)
  await page.goto(`/w/${workspaceId}/board?lens=all`)
  await expect(openers(page)).toHaveCount(1, { timeout: 30_000 })
  await openers(page).first().click()
  await expect.poll(() => panelParam(page)).toMatch(/^conv:[^.]+$/)
  const opened = panelParam(page)
  const pane = page.locator(`[data-panel-tab="${opened}"]`)
  await pane.getByRole("textbox").first().click()

  await page.keyboard.press("Alt+,")
  await expect(page.locator("[data-board-scroll-viewport]")).toBeFocused()

  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => panelParam(page)).toContain("page:board**")
  await page.keyboard.press("Alt+Enter")
  await expect.poll(() => panelParam(page)).toBe(opened)
  await page.keyboard.press("Alt+.")
  await expect(pane.locator("[contenteditable=true]").first()).toBeFocused()
})

test("should show no tab for the board named in the URL", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId } = await seedConversations(page, 1)
  await page.goto(`/w/${workspaceId}/board?lens=all&panel=page:board`)
  await expect(openers(page)).toHaveCount(1, { timeout: 30_000 })

  await expect(board(page)).toHaveCount(1)
  await expect(page.getByTestId("panel")).toHaveCount(0)
  await expect(page.getByRole("navigation", { name: "Panel tabs" })).toHaveCount(0)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test("should stack a card's pane over the board and come back to the board where it was scrolled", async ({
    page,
  }) => {
    const { workspaceId } = await seedConversations(page, 6)
    await page.goto(`/w/${workspaceId}/board?lens=all`)
    await expect(openers(page).first()).toBeVisible({ timeout: 30_000 })
    await expect(board(page).getByRole("button", { name: /sidebar/ })).toBeVisible()

    await page.locator("[data-board-scroll-viewport]").evaluate((el) => el.scrollTo({ top: 600 }))
    // Cards measured as they virtualize in move the scroll a while after it is set.
    let scrolled = -1
    await expect
      .poll(
        async () => {
          const settled = scrolled
          scrolled = await boardScrollTop(page)
          return scrolled > 0 && scrolled === settled
        },
        { intervals: [300] }
      )
      .toBe(true)

    // A DOM click: Playwright's own would first scroll a clipped opener into view and move the board.
    await openers(page)
      .locator("visible=true")
      .first()
      .evaluate((el: HTMLElement) => el.click())
    await expect.poll(() => panelParam(page)).toMatch(/^conv:[^.]+$/)
    const pane = page.getByTestId("panel")
    await expect(pane).toBeVisible()
    await expect(board(page)).not.toBeVisible()
    expect(await boardScrollTop(page)).toBe(scrolled)

    await page.goBack()
    await expect.poll(() => panelParam(page)).toBeNull()
    await expect(board(page)).toBeVisible()
    expect(await boardScrollTop(page)).toBe(scrolled)
  })
})

// A touch tablet is wide, but shows one pane at a time as a phone does.
test.describe("on a touch tablet", () => {
  test.use({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true })

  test("should show a card's pane over the board through a reload, and the board again on Back", async ({ page }) => {
    const { workspaceId } = await seedConversations(page, 1)
    await page.goto(`/w/${workspaceId}/board?lens=all`)
    await expect(openers(page).first()).toBeVisible({ timeout: 30_000 })
    await openers(page)
      .locator("visible=true")
      .first()
      .evaluate((el: HTMLElement) => el.click())
    await expect.poll(() => panelParam(page)).toMatch(/^conv:[^.]+$/)
    await expect(page.getByTestId("panel")).toBeVisible()
    await expect(board(page)).not.toBeVisible()

    await page.reload()
    await expect(page.getByTestId("panel")).toBeVisible({ timeout: 30_000 })
    await expect(board(page)).not.toBeVisible()

    await page.goBack()
    await expect.poll(() => panelParam(page)).toBeNull()
    await expect(board(page)).toBeVisible()
  })
})
