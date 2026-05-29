import { test, expect } from "@playwright/test"
import {
  clickReplyInThread,
  createChannel,
  expandCollapsedSidebarSections,
  generateTestId,
  loginAndCreateWorkspace,
  sendPanelReply,
  setSmartSidebarPreset,
  waitForRealThreadPanel,
} from "./helpers"

/**
 * Tests for thread breadcrumb display, navigation, and sidebar context.
 *
 * Covers:
 * - Breadcrumb ancestor chain renders correctly in thread panels
 * - Navigation via breadcrumb links works (up-chevron was removed)
 * - Sidebar shows thread root context suffix (e.g., "· #general")
 */

test.describe("Thread Breadcrumbs", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "breadcrumb")
  })

  test("should show ancestor chain in breadcrumbs and navigate via breadcrumb click", async ({ page }) => {
    const testId = generateTestId()

    // Create a channel
    const channelName = `bc-nav-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    // Post a message in the channel
    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    const channelMessage = `BC nav test ${testId}`
    await page.keyboard.type(channelMessage)
    await page.keyboard.press("Meta+Enter")
    await expect(page.getByRole("main").locator(".message-item").getByText(channelMessage)).toBeVisible({
      timeout: 10000,
    })

    // Create a first-level thread
    const messageContainer = page.getByRole("main").locator(".message-item").filter({ hasText: channelMessage }).first()
    await clickReplyInThread(messageContainer)
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // Draft breadcrumbs should show the channel as ancestor and "New thread" as current
    const breadcrumbNav = page.locator("nav[aria-label='breadcrumb']")
    await expect(breadcrumbNav.getByText(`#${channelName}`)).toBeVisible({ timeout: 5000 })
    await expect(breadcrumbNav.getByText("New thread")).toBeVisible({ timeout: 3000 })

    // Send thread reply to create the thread
    const level1Reply = `Level 1 reply ${testId}`
    await sendPanelReply(page, level1Reply)
    await expect(page.getByTestId("panel").getByText(level1Reply)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/Start a new thread/)).not.toBeVisible({ timeout: 3000 })
    await waitForRealThreadPanel(page)

    // After thread creation, breadcrumbs should still show the channel
    await expect(breadcrumbNav.getByText(`#${channelName}`)).toBeVisible({ timeout: 5000 })

    // Create a second-level nested thread
    const level1Container = page.getByTestId("panel").locator(".message-item").filter({ hasText: level1Reply }).first()
    await clickReplyInThread(level1Container)
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // Draft breadcrumbs for nested thread should show channel + parent thread as ancestors
    await expect(breadcrumbNav.getByText(`#${channelName}`)).toBeVisible({ timeout: 5000 })
    await expect(breadcrumbNav.getByText("New thread")).toBeVisible({ timeout: 3000 })

    // Send nested thread reply
    const level2Reply = `Level 2 reply ${testId}`
    await sendPanelReply(page, level2Reply)
    await expect(page.getByTestId("panel").getByText(level2Reply)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/Start a new thread/)).not.toBeVisible({ timeout: 3000 })

    // Navigate to the channel by clicking its breadcrumb link.
    // Since the channel is the main view, clicking it should close the panel.
    const channelBreadcrumb = breadcrumbNav.getByRole("link", { name: `#${channelName}` }).first()
    if (await channelBreadcrumb.isVisible()) {
      await channelBreadcrumb.click()
    } else {
      // Breadcrumb might be a button (for main-view streams that close the panel)
      const channelButton = breadcrumbNav.getByRole("button", { name: `#${channelName}` }).first()
      await channelButton.click()
    }

    // Should be back viewing the channel with the original message visible
    await expect(page.getByRole("main").getByText(channelMessage).first()).toBeVisible({ timeout: 3000 })
  })

  test("should show thread with root context suffix in sidebar", async ({ page }) => {
    const testId = generateTestId()

    // Create a channel
    const channelName = `sidebar-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    // Post a message
    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    const channelMessage = `Sidebar context ${testId}`
    await page.keyboard.type(channelMessage)
    await page.keyboard.press("Meta+Enter")
    await expect(page.getByRole("main").locator(".message-item").getByText(channelMessage)).toBeVisible({
      timeout: 10000,
    })

    // Create a thread
    const messageContainer = page.getByRole("main").locator(".message-item").filter({ hasText: channelMessage }).first()
    await clickReplyInThread(messageContainer)
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // Send thread reply to create the thread
    await sendPanelReply(page, `Thread reply ${testId}`)
    await expect(page.getByTestId("panel").getByText(`Thread reply ${testId}`)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/Start a new thread/)).not.toBeVisible({ timeout: 3000 })
    await waitForRealThreadPanel(page)

    // Threads only appear in the Smart preset's urgency buckets — the suite's
    // default All preset has type sections (Channels/Scratchpads/DMs) that never
    // include threads. Switch to Smart (reloads, so the bootstrap also reflects
    // the new thread) and expand any collapsed bucket the thread landed in.
    await setSmartSidebarPreset(page)
    await expect(page.getByRole("navigation", { name: "Sidebar navigation" })).toBeVisible({ timeout: 10000 })
    await expandCollapsedSidebarSections(page)

    // The sidebar should show the thread with a root context suffix " · #channel-name"
    // This unique format (dot separator + channel slug) only appears on thread entries
    await expect(page.getByText(`· #${channelName}`).first()).toBeVisible({ timeout: 10000 })
  })
})
