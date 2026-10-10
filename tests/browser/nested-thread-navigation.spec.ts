import { test, expect, type Page } from "@playwright/test"
import {
  clickReplyInThread,
  createChannel,
  expectApiOk,
  generateTestId,
  getActivePanel,
  loginAndCreateWorkspace,
  sendPanelReply,
  waitForRealThreadPanel,
} from "./helpers"

/**
 * Tests for nested thread navigation and bootstrapping.
 *
 * These tests verify that when navigating between thread levels,
 * the thread state is properly bootstrapped with correct reply counts.
 *
 * Critical bug: Navigating back to parent threads or reopening threads does
 * not properly show nested thread reply counts.
 *
 * A nested thread opens as a second panel tab beside its parent, so "back" is
 * the parent's tab, and assertions after that point scope to the tab on show.
 */

const openPanelIds = (page: Page) =>
  new URL(page.url()).searchParams
    .get("panel")!
    .split(".")
    .map((id) => id.replace("*", ""))

/** Brings an open thread's tab to the front from the tab row and waits for it to show. */
async function switchToTab(page: Page, threadId: string): Promise<void> {
  await getActivePanel(page)
    .getByRole("navigation", { name: "Panel tabs" })
    .getByRole("link")
    .nth(openPanelIds(page).indexOf(threadId))
    .click()
  await expect(getActivePanel(page)).toHaveAttribute("data-panel-tab", threadId)
}

test.describe("Nested Thread Navigation", () => {
  async function sendChannelMessageViaApi(page: Page, text: string): Promise<void> {
    const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
    expect(match).toBeTruthy()
    const [, workspaceId, streamId] = match!

    const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: {
        streamId,
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        },
        contentMarkdown: text,
      },
    })
    await expectApiOk(response, `Create stream message: ${text}`)
  }

  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "nested-thread")
  })

  test("should show nested thread reply count when switching back to the parent thread's tab", async ({ page }) => {
    test.setTimeout(90000)
    const testId = generateTestId()

    // Create a channel (creating navigates to it)
    const channelName = `nested-breadcrumb-${testId}`
    await createChannel(page, channelName)

    // Post a message in the channel
    const channelMessage = `Channel message ${testId}`
    await sendChannelMessageViaApi(page, channelMessage)

    await expect(
      page.getByRole("main").locator(".message-item").filter({ hasText: channelMessage }).first()
    ).toBeVisible({
      timeout: 5000,
    })

    // Start a first-level thread by replying to the channel message
    const messageContainer = page.getByRole("main").locator(".message-item").filter({ hasText: channelMessage }).first()
    await clickReplyInThread(messageContainer)

    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // Send first-level thread reply
    const firstReply = `First level reply ${testId}`
    await sendPanelReply(page, firstReply)

    // Scope to thread panel to avoid matching hidden sidebar/breadcrumb text
    await expect(page.getByTestId("panel").getByText(firstReply)).toBeVisible({ timeout: 5000 })

    // Wait for thread to be created (draft transitions to real thread)
    await waitForRealThreadPanel(page)
    const [parentThreadId] = openPanelIds(page)

    // Now reply to the first-level thread reply to create a nested (second-level) thread
    const firstReplyContainer = page
      .getByTestId("panel")
      .locator(".message-item")
      .filter({ hasText: firstReply })
      .first()
    await clickReplyInThread(firstReplyContainer)

    // Wait for nested thread draft panel to appear
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // Send nested thread reply
    const nestedReply = `Nested thread reply ${testId}`
    await sendPanelReply(page, nestedReply)

    await expect(getActivePanel(page).getByText(nestedReply)).toBeVisible({ timeout: 5000 })

    // Wait for nested thread to be created
    await waitForRealThreadPanel(page)

    // Switch back to the first-level thread's tab
    await switchToTab(page, parentThreadId)

    // Verify we're back in the first-level thread by checking for the firstReply message
    await expect(getActivePanel(page).getByText(firstReply).first()).toBeVisible({ timeout: 5000 })

    // CRITICAL: The firstReply message should show as having 1 reply (the nested thread)
    const firstReplyInPanel = getActivePanel(page).locator(".message-item").filter({ hasText: firstReply }).first()
    await expect(firstReplyInPanel).toContainText(/1 reply/i, { timeout: 45000 })
  })

  test("should show nested thread indicator when reopening parent thread", async ({ page }) => {
    test.setTimeout(90000)
    const testId = generateTestId()

    // Create a channel (creating navigates to it)
    const channelName = `nested-reopen-${testId}`
    await createChannel(page, channelName)

    // Post a message in the channel
    const channelMessage = `Channel post ${testId}`
    await sendChannelMessageViaApi(page, channelMessage)

    await expect(
      page.getByRole("main").locator(".message-item").filter({ hasText: channelMessage }).first()
    ).toBeVisible({
      timeout: 5000,
    })

    // Start a thread on the channel message
    const messageContainer = page.getByRole("main").locator(".message-item").filter({ hasText: channelMessage }).first()
    await clickReplyInThread(messageContainer)

    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // Send thread reply
    const threadReply = `Thread reply ${testId}`
    await sendPanelReply(page, threadReply)

    await expect(page.getByTestId("panel").getByText(threadReply)).toBeVisible({ timeout: 5000 })
    await waitForRealThreadPanel(page)

    // Reply to the thread reply to create a nested thread
    const threadReplyContainer = page
      .getByTestId("panel")
      .locator(".message-item")
      .filter({ hasText: threadReply })
      .first()
    await clickReplyInThread(threadReplyContainer)

    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // Send nested reply
    const nestedReply = `Nested reply ${testId}`
    await sendPanelReply(page, nestedReply)

    await expect(getActivePanel(page).getByText(nestedReply)).toBeVisible({ timeout: 5000 })
    await waitForRealThreadPanel(page)

    // Return to the main stream with no panel open through the channel's
    // sidebar link (tabbed panels show no channel breadcrumb), without
    // depending on close-button click animations settling first.
    await page
      .getByRole("navigation", { name: "Sidebar navigation" })
      .getByRole("link", { name: `#${channelName}` })
      .first()
      .click()
    await expect(page).not.toHaveURL(/panel=/)
    await expect(page.locator("[data-panel-tab]")).toHaveCount(0)

    // Reopen the first-level thread by clicking on the reply count in the main stream
    const channelMessageInMain = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: channelMessage })
      .first()
    const threadIndicator = channelMessageInMain.getByText(/1 reply/i)
    await expect(threadIndicator).toBeVisible({ timeout: 3000 })
    await threadIndicator.click()

    // Thread should reopen and show the threadReply. Bootstrap refetch is
    // triggered by useStreamSocket on re-mount, which includes updated reply counts.
    await expect(page.getByTestId("panel").getByText(threadReply)).toBeVisible({ timeout: 10000 })

    // CRITICAL: The threadReply message should show as having a nested thread (1 reply).
    // The reply count arrives via bootstrap refetch after the stream socket re-subscribes.
    const threadReplyInPanel = page
      .getByTestId("panel")
      .locator(".message-item")
      .filter({ hasText: threadReply })
      .first()
    await expect
      .poll(async () => (await threadReplyInPanel.textContent()) ?? "", { timeout: 45000 })
      .toMatch(/1 reply/i)
  })

  test("should maintain reply counts across multiple navigation cycles", async ({ page }) => {
    const testId = generateTestId()

    test.setTimeout(90000)

    // Create a channel (creating navigates to it)
    const channelName = `nav-cycles-${testId}`
    await createChannel(page, channelName)

    // Post in channel
    const rootMessage = `Root ${testId}`
    await sendChannelMessageViaApi(page, rootMessage)
    await expect(page.getByRole("main").locator(".message-item").filter({ hasText: rootMessage }).first()).toBeVisible({
      timeout: 5000,
    })

    // Create first-level thread
    const rootContainer = page.getByRole("main").locator(".message-item").filter({ hasText: rootMessage }).first()
    await clickReplyInThread(rootContainer)
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    const level1Message = `Level 1 ${testId}`
    await sendPanelReply(page, level1Message)
    await expect(page.getByTestId("panel").getByText(level1Message)).toBeVisible({ timeout: 10000 })
    await waitForRealThreadPanel(page)
    const [level1ThreadId] = openPanelIds(page)

    // Create nested thread
    const level1Container = page
      .getByTestId("panel")
      .locator(".message-item")
      .filter({ hasText: level1Message })
      .first()
    await clickReplyInThread(level1Container)
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    const level2Message = `Level 2 ${testId}`
    await sendPanelReply(page, level2Message)
    await waitForRealThreadPanel(page)
    await expect(getActivePanel(page).getByText(level2Message)).toBeVisible({ timeout: 10000 })
    const [, level2ThreadId] = openPanelIds(page)

    // Switch back to the parent thread's tab
    await switchToTab(page, level1ThreadId)

    // Verify reply count shows
    const level1InPanel = getActivePanel(page).locator(".message-item").filter({ hasText: level1Message }).first()
    await expect(level1InPanel).toContainText(/1 reply/i, { timeout: 20000 })

    // Navigate forward again by clicking the reply count: brings the nested thread's tab forward
    await level1InPanel.getByText(/1 reply/i).click()
    await expect(getActivePanel(page)).toHaveAttribute("data-panel-tab", level2ThreadId)
    await expect(getActivePanel(page).getByText(level2Message)).toBeVisible({ timeout: 10000 })

    // Switch back again
    await switchToTab(page, level1ThreadId)

    // Reply count should still show correctly
    await expect(level1InPanel).toContainText(/1 reply/i, { timeout: 20000 })
  })
})
