import { test, expect, type Page } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace, switchToAllView } from "./helpers"

/**
 * Tests for editor auto-focus behavior:
 *
 * 1. Main editor focused on page load
 * 2. Main editor refocused after stream navigation
 * 3. Thread panel editor focused on panel open
 * 4. Type-to-focus: typing in main view focuses main editor + inserts character
 * 5. Type-to-focus: typing with panel open focuses panel editor when last clicked
 * 6. Focus restoration after inline edit cancel
 */

async function sendMessage(page: Page, text: string) {
  const editor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
  await editor.click()
  await page.keyboard.type(text)
  await page.keyboard.press("Meta+Enter")
  // Scope to .message-item to avoid matching sidebar preview text
  await expect(page.getByRole("main").locator(".message-item").getByText(text).first()).toBeVisible({ timeout: 5000 })
}

test.describe("Editor Auto-Focus", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "focus-test")
  })

  test("main editor is focused on page load", async ({ page }) => {
    const testId = Date.now().toString(36)
    const channelName = `focus-load-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    // The editor should already be focused — type and verify
    const mainEditor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
    await expect(mainEditor).toBeFocused({ timeout: 3000 })
  })

  test("main editor refocuses after stream navigation", async ({ page }) => {
    const testId = Date.now().toString(36)

    // Create a channel then navigate away and back
    const channelName = `focus-nav-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    // Switch to the type-based "All" sidebar layout so the channel link is
    // always visible (the old Smart/All toggle button is gone — layout is now
    // driven by the persisted sidebar config).
    await switchToAllView(page)

    // Navigate to Drafts (away from channel)
    await page.getByRole("link", { name: "Drafts" }).click()
    await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible({ timeout: 5000 })

    // Navigate back to the channel via sidebar link (text includes # prefix)
    const sidebarLink = page.getByRole("link", { name: `#${channelName}` })
    await expect(sidebarLink).toBeVisible({ timeout: 5000 })
    await sidebarLink.click()
    await expect(page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({ timeout: 5000 })

    // Editor should be focused after navigation
    const mainEditor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
    await expect(mainEditor).toBeFocused({ timeout: 10000 })
  })

  test("thread panel editor is focused on panel open", async ({ page }) => {
    const testId = Date.now().toString(36)
    const channelName = `focus-panel-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    // Send a message to get a thread target
    await sendMessage(page, `Panel focus test ${testId}`)

    // Open thread panel
    const messageContainer = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `Panel focus test ${testId}` })
      .first()
    await messageContainer.hover()
    const replyLink = messageContainer.getByRole("link", { name: "Reply in thread" })
    await expect(replyLink).toBeVisible({ timeout: 5000 })
    await replyLink.click()

    // Wait for the thread panel to appear
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // The panel's editor should be focused
    const panelEditor = page.locator("[data-editor-zone='panel'] [contenteditable='true']")
    await expect(panelEditor).toBeFocused({ timeout: 3000 })
  })

  test("type-to-focus: typing focuses main editor and inserts character", async ({ page }) => {
    const testId = Date.now().toString(36)
    const channelName = `focus-type-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    // Click somewhere outside the editor to blur it (e.g. the header)
    await page.locator("header").first().click()

    // Verify the editor lost focus
    const mainEditor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
    await expect(mainEditor).not.toBeFocused()

    // Type a character — should auto-focus and insert
    await page.keyboard.press("h")

    await expect(mainEditor).toBeFocused({ timeout: 2000 })
    await expect(mainEditor).toContainText("h")
  })

  test("type-to-focus: typing with panel focuses panel editor when last clicked", async ({ page }) => {
    const testId = Date.now().toString(36)
    const channelName = `focus-type-panel-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    // Send a message and open thread
    await sendMessage(page, `Type panel test ${testId}`)

    const messageContainer = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `Type panel test ${testId}` })
      .first()
    await messageContainer.hover()
    const replyLink = messageContainer.getByRole("link", { name: "Reply in thread" })
    await expect(replyLink).toBeVisible({ timeout: 5000 })
    await replyLink.click()

    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })

    // Click in the panel area to register it as last zone
    const panelEditor = page.locator("[data-editor-zone='panel'] [contenteditable='true']")
    await panelEditor.click()

    // Click the panel header to blur the editor (but stay in the panel zone)
    const panelHeader = page.getByTestId("panel").locator("header")
    await panelHeader.click()

    // Type a character — should focus the panel editor (last-clicked zone)
    await page.keyboard.press("x")

    await expect(panelEditor).toBeFocused({ timeout: 2000 })
    await expect(panelEditor).toContainText("x")
  })

  test("focus restores to zone editor after inline edit cancel", async ({ page }) => {
    const testId = Date.now().toString(36)
    const channelName = `focus-edit-${testId}`
    await createChannel(page, channelName, { switchToAll: false })

    // Send a message from current user
    const messageText = `Edit restore test ${testId}`
    await sendMessage(page, messageText)

    // Open context menu and start editing. Retry the hover→click sequence
    // because in CI the hover-reveal can race with layout shifts.
    const messageContainer = page.getByRole("main").locator(".message-item").filter({ hasText: messageText }).first()
    const editOption = page.getByRole("menuitem", { name: "Edit message" })

    for (let attempt = 0; attempt < 3; attempt++) {
      await messageContainer.hover()
      const menuTrigger = messageContainer.getByRole("button", { name: "Message actions" })
      await expect(menuTrigger).toBeVisible({ timeout: 5000 })
      await menuTrigger.click()
      try {
        await expect(editOption).toBeVisible({ timeout: 3000 })
        break
      } catch {
        if (attempt === 2) throw new Error("Failed to open context menu after 3 attempts")
        await page.keyboard.press("Escape").catch(() => {})
      }
    }
    await editOption.click()

    // Verify edit form appeared
    const editEditor = page.locator("[data-inline-edit] [contenteditable='true']")
    await expect(editEditor).toBeVisible({ timeout: 3000 })

    // Cancel by pressing Escape
    await page.keyboard.press("Escape")
    await expect(editEditor).toBeHidden({ timeout: 3000 })

    // After cancel, the zone's message input editor should be focused
    const mainEditor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
    await expect(mainEditor).toBeFocused({ timeout: 3000 })
  })
})
