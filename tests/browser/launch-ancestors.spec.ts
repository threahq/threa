import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import {
  clickReplyInThread,
  createChannel,
  loginAndCreateWorkspace,
  sendPanelReply,
  waitForRealThreadPanel,
} from "./helpers"

/**
 * A cold launch (direct URL, PWA relaunch) starts with nothing beneath the
 * page, so the first back gesture would leave the app. The rebuild pushes the
 * page's ancestors underneath once: a thread gets its channel, a `?panel=` URL
 * gets the page without the panel. Back then walks them, and nothing is pushed
 * after a back (Chrome marks such entries skippable, and Android back would
 * exit the PWA — #2189).
 */

test.describe.configure({ timeout: 240_000 })

declare global {
  interface Window {
    __pushes?: number
  }
}

/** A fresh tab is the cold launch: one history entry, nothing beneath. A
 *  `goto` in the tab that built the fixture would reload onto the entries it
 *  already holds, and a reload rebuilds nothing. */
async function coldLaunch(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__pushes = 0
    const push = history.pushState.bind(history)
    history.pushState = (...args) => {
      window.__pushes = (window.__pushes ?? 0) + 1
      push(...args)
    }
  })
  await page.goto(url)
  return page
}

const pushes = (page: Page) => page.evaluate(() => window.__pushes ?? 0)

async function createThread(page: Page, testId: string): Promise<{ channelId: string; threadId: string }> {
  await createChannel(page, `launch-${testId}`, { switchToAll: false })
  const channelId = page.url().match(/\/s\/([^/?]+)/)![1]
  const editor = page.locator("[contenteditable='true']")
  await editor.click()
  await page.keyboard.type(`launch root ${testId}`)
  await page.keyboard.press("Meta+Enter")
  const row = page
    .getByRole("main")
    .locator(".message-item")
    .filter({ hasText: `launch root ${testId}` })
    .first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await clickReplyInThread(row)
  await sendPanelReply(page, `launch reply ${testId}`)
  await waitForRealThreadPanel(page)
  const threadId = new URL(page.url()).searchParams.get("panel")!
  return { channelId, threadId }
}

test.describe("Launch ancestors", () => {
  test("a thread launched by URL gets its channel beneath it", async ({ page: setup, context }) => {
    const { testId } = await loginAndCreateWorkspace(setup, "launch-thread")
    const { channelId, threadId } = await createThread(setup, testId)
    const base = new URL(setup.url()).origin
    const workspaceId = setup.url().match(/\/w\/([^/?]+)/)![1]

    const page = await coldLaunch(context, `${base}/w/${workspaceId}/s/${threadId}`)
    await expect(page.getByRole("main").getByText(`launch reply ${testId}`).first()).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => pushes(page), { timeout: 20_000 }).toBe(1)

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/s/${channelId}(\\?|$)`), { timeout: 10_000 })
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `launch root ${testId}` })
        .first()
    ).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)
    expect(await pushes(page)).toBe(1)
  })

  test("a panel URL launched cold gets the page beneath it, so back closes the panel", async ({
    page: setup,
    context,
  }) => {
    const { testId } = await loginAndCreateWorkspace(setup, "launch-panel")
    const { channelId, threadId } = await createThread(setup, testId)
    const base = new URL(setup.url()).origin
    const workspaceId = setup.url().match(/\/w\/([^/?]+)/)![1]

    const page = await coldLaunch(context, `${base}/w/${workspaceId}/s/${channelId}?panel=${threadId}`)
    await expect(page.getByTestId("panel").getByText(`launch reply ${testId}`)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => pushes(page), { timeout: 20_000 }).toBe(1)

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/s/${channelId}$`), { timeout: 10_000 })
    await expect(page.getByTestId("panel").getByText(`launch reply ${testId}`)).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(await pushes(page)).toBe(1)
  })
})
