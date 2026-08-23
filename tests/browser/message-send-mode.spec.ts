import { test, expect } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * Tests for configurable message send mode feature.
 *
 * Two modes:
 * - "enter" (default): Enter sends, Shift+Enter creates newlines
 * - "cmdEnter": Cmd/Ctrl+Enter sends, Enter creates newlines
 *
 * Note: Cmd+Enter ALWAYS sends regardless of mode.
 */

test.describe("Message Send Mode", () => {
  let testId: string

  /**
   * Helper to open settings dialog via keyboard shortcut.
   * Uses Cmd+. (Mac) which is the app's default shortcut.
   */
  async function openSettings(page: import("@playwright/test").Page) {
    await page.keyboard.press("Meta+.")
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 })
  }

  /**
   * Helper to change send mode in settings.
   * Uses exact role match for radio buttons since both labels contain "Enter to send".
   */
  async function setSendMode(page: import("@playwright/test").Page, mode: "enter" | "cmdEnter") {
    await openSettings(page)
    const dialog = page.getByRole("dialog")

    // Wait for the responsive nav to mount before selecting Composer; checking
    // visibility immediately races the dialog's deferred content render.
    const composerSidebarButton = dialog.getByRole("button", { name: /^Composer\b/ })
    await expect(composerSidebarButton).toBeVisible({ timeout: 5000 })
    await composerSidebarButton.click()

    await expect(dialog.getByRole("radio", { name: "Enter to send", exact: true })).toBeVisible({ timeout: 5000 })

    // Use exact name match for radio buttons
    if (mode === "enter") {
      await dialog.getByRole("radio", { name: "Enter to send", exact: true }).click()
    } else {
      await dialog.getByRole("radio", { name: "⌘/Ctrl + Enter to send", exact: true }).click()
    }
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
  }

  test.beforeEach(async ({ page }) => {
    const result = await loginAndCreateWorkspace(page, "sendmode")
    testId = result.testId
  })

  test.describe("default enter mode", () => {
    test("should expose the editor as a named textbox with keyboard instructions", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()

      const editor = page.getByRole("textbox", { name: "Message input" })
      await expect(editor).toBeVisible({ timeout: 5000 })
      await expect(page.getByText("Tab and Shift+Tab indent content. Press Escape to leave the editor.")).toBeAttached()
    })

    test("should send message with Enter", async ({ page }) => {
      // Create a scratchpad to test in
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      const messageContent = `Enter test ${testId}`
      await page.locator("[contenteditable='true']").click()
      await page.keyboard.type(messageContent)

      // Enter should send in default mode
      await page.keyboard.press("Enter")

      // Message should appear in the page (sent successfully)
      await expect(page.locator("p").filter({ hasText: messageContent }).first()).toBeVisible({ timeout: 5000 })
    })

    test("should send on a mobile-keyboard Enter (beforeinput insertParagraph)", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      const editor = page.locator("[contenteditable='true']")
      await expect(editor).toBeVisible({ timeout: 5000 })

      const messageContent = `Beforeinput enter test ${testId}`
      await editor.click()
      await page.keyboard.type(messageContent)

      // Chrome Android drops keydown Enter inside ProseMirror; the keystroke
      // only surfaces as this event.
      await editor.evaluate((element) => {
        element.dispatchEvent(
          new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertParagraph" })
        )
      })

      await expect(page.locator("p").filter({ hasText: messageContent }).first()).toBeVisible({ timeout: 5000 })
      await expect(editor).not.toContainText(messageContent)
    })

    test("should create newline with Shift+Enter (not send)", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      const line1 = `Line1 ${testId}`
      const line2 = `Line2 ${testId}`

      await page.locator("[contenteditable='true']").click()
      await page.keyboard.type(line1)
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type(line2)

      // Both lines should be in the editor
      const editor = page.locator("[contenteditable='true']")
      await expect(editor).toContainText(line1)
      await expect(editor).toContainText(line2)

      // Verify message is still in editor (not sent)
      await expect(page.getByText("Start a conversation")).toBeVisible()
    })

    test("should show correct hint in enter mode", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      // The desktop send hint is shown below the composer card in this viewport
      await expect(page.getByText("Enter to send · Shift+Enter for new line").first()).toBeVisible({ timeout: 2000 })
    })

    test("Cmd+Enter should also send in enter mode", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      const messageContent = `CmdEnter also sends ${testId}`
      await page.locator("[contenteditable='true']").click()
      await page.keyboard.type(messageContent)

      // Cmd+Enter should ALWAYS send regardless of mode
      await page.keyboard.press("Meta+Enter")

      // Message should appear (sent successfully)
      await expect(page.locator("p").filter({ hasText: messageContent }).first()).toBeVisible({ timeout: 5000 })
    })

    test("should blur the editor with Escape", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()

      const editor = page.getByRole("textbox", { name: "Message input" })
      await expect(editor).toBeVisible({ timeout: 5000 })
      await editor.click()
      await expect(editor).toBeFocused()

      await page.keyboard.press("Escape")

      await expect(editor).not.toBeFocused()
    })

    test("should require a second Escape to close the fullscreen editor", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()

      await page.getByRole("button", { name: "Expand to fullscreen editor" }).click()

      const fullscreenEditor = page.getByRole("textbox", { name: "Fullscreen message editor" })
      await expect(fullscreenEditor).toBeVisible({ timeout: 5000 })
      await expect(fullscreenEditor).toBeFocused()

      await page.keyboard.press("Escape")
      await expect(fullscreenEditor).toBeVisible()
      await expect(fullscreenEditor).not.toBeFocused()

      await page.keyboard.press("Escape")
      await expect(fullscreenEditor).not.toBeVisible()
      await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible()
    })
  })

  test.describe("cmdEnter mode (via settings)", () => {
    test.beforeEach(async ({ page }) => {
      // Change to cmdEnter mode
      await setSendMode(page, "cmdEnter")
    })

    test("should send message with Cmd+Enter", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      const messageContent = `CmdEnter send test ${testId}-${Date.now()}`
      await page.locator("[contenteditable='true']").click()
      await page.keyboard.type(messageContent)

      // Cmd+Enter should send in this mode
      await page.keyboard.press("Meta+Enter")

      // Message should appear (sent successfully)
      await expect(page.locator("p").filter({ hasText: messageContent }).first()).toBeVisible({ timeout: 5000 })
    })

    test("should create newline with Enter (not send)", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      const line1 = `CmdMode Line1 ${testId}`
      const line2 = `CmdMode Line2 ${testId}`

      await page.locator("[contenteditable='true']").click()
      await page.keyboard.type(line1)
      await page.keyboard.press("Enter")
      await page.keyboard.type(line2)

      // Both lines should be in the editor
      const editor = page.locator("[contenteditable='true']")
      await expect(editor).toContainText(line1)
      await expect(editor).toContainText(line2)

      // Verify message not sent - "Start a conversation" still visible
      await expect(page.getByText("Start a conversation")).toBeVisible()
    })

    test("should show correct hint in cmdEnter mode", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      // The desktop send hint is shown below the composer card in this viewport
      await expect(page.getByText(/⌘Enter to send|Ctrl\+Enter to send/).first()).toBeVisible({ timeout: 2000 })
    })
  })

  test.describe("list behavior in enter mode", () => {
    test("should send after exiting list with Enter on empty item", async ({ page }) => {
      // This test reproduces the reported issue:
      // Type "- item 1", Shift+Enter, "- item 2", Enter
      // Expected: list exits and message sends
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      await page.locator("[contenteditable='true']").click()

      // Create a bullet list
      await page.keyboard.type("- item 1")
      // Shift+Enter in list creates a new list item
      await page.keyboard.press("Shift+Enter")
      // Type second item (we're already in a list, so no need for "- ")
      await page.keyboard.type("item 2")
      // Enter on non-empty item should create new item
      await page.keyboard.press("Enter")
      // Now we're on an empty list item, Enter should exit list AND send
      await page.keyboard.press("Enter")

      // Message should be sent - look for list items in the timeline
      await expect(page.locator("li").filter({ hasText: "item 1" }).first()).toBeVisible({ timeout: 5000 })
      await expect(page.locator("li").filter({ hasText: "item 2" }).first()).toBeVisible({ timeout: 5000 })
    })

    test("Enter on plain text should send immediately", async ({ page }) => {
      // This tests the basic case: plain text + Enter = send
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      const messageContent = `Plain text enter test ${Date.now()}`
      await page.locator("[contenteditable='true']").click()
      await page.keyboard.type(messageContent)

      // Verify message is in editor before sending
      const editor = page.locator("[contenteditable='true']")
      await expect(editor).toContainText(messageContent)

      // Enter should send immediately for plain text
      await page.keyboard.press("Enter")

      // Message should appear in the timeline (sent successfully)
      await expect(page.locator("p").filter({ hasText: messageContent }).first()).toBeVisible({ timeout: 5000 })
    })
  })

  test.describe("multi-line content in enter mode", () => {
    test("should create multi-line content with Shift+Enter", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      await page.locator("[contenteditable='true']").click()

      // Type multi-line content using Shift+Enter for newlines
      await page.keyboard.type("Line 1 content")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("Line 2 content")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("Line 3 content")

      // All lines should be in editor (verifies Shift+Enter creates newlines, not sends)
      const editor = page.locator("[contenteditable='true']")
      await expect(editor).toContainText("Line 1 content")
      await expect(editor).toContainText("Line 2 content")
      await expect(editor).toContainText("Line 3 content")

      // Message should NOT have been sent - "Start a conversation" still visible
      await expect(page.getByText("Start a conversation")).toBeVisible()
    })

    test("should support code blocks with Shift+Enter for newlines", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      await page.locator("[contenteditable='true']").click()

      // Type code block opener
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("const x = 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("const y = 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("```")

      // Code should be in editor
      const editor = page.locator("[contenteditable='true']")
      await expect(editor).toContainText("const x = 1")
      await expect(editor).toContainText("const y = 2")
    })
  })

  test.describe("stale closure regression", () => {
    /**
     * These tests verify that keyboard handlers remain functional after
     * various interactions that trigger re-renders.
     *
     * NOTE: These tests don't actually catch the stale closure bug that was
     * fixed. The bug required conditions we couldn't reproduce in tests
     * (possibly related to data volume causing more re-renders). The tests
     * still have value as regression tests for "Enter-to-send works after
     * complex interactions".
     *
     * The fix: Enter handling moved to handleKeyDown (fresh refs per keypress)
     * instead of TipTap extension shortcuts (refs captured at initialization).
     */

    test("should send after opening and closing mention suggestion", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      await page.locator("[contenteditable='true']").click()

      // Type something
      await page.keyboard.type("Hello ")

      // Trigger mention suggestion (causes re-renders)
      await page.keyboard.type("@")
      // Wait for suggestion popup to appear
      await expect(page.locator('[role="listbox"]')).toBeVisible()

      // Close suggestion with Escape
      await page.keyboard.press("Escape")
      await expect(page.locator('[role="listbox"]')).not.toBeVisible()

      // Continue typing
      await page.keyboard.press("Backspace") // Remove the @
      await page.keyboard.type("world")

      // Now try to send - this is where stale closures would fail
      await page.keyboard.press("Enter")

      // Message should be sent
      await expect(page.locator("p").filter({ hasText: "Hello world" }).first()).toBeVisible({ timeout: 5000 })
    })

    test("should send after multiple focus/blur cycles", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Type something
      await page.keyboard.type("Focus test")

      // Blur by clicking outside editor (Tab is trapped for indentation)
      await page.locator("body").click({ position: { x: 10, y: 10 } })
      await expect(editor).not.toBeFocused()
      await editor.click() // Refocus

      await page.locator("body").click({ position: { x: 10, y: 10 } })
      await expect(editor).not.toBeFocused()
      await editor.click()

      await page.locator("body").click({ position: { x: 10, y: 10 } })
      await expect(editor).not.toBeFocused()
      await editor.click()

      // Continue typing
      await page.keyboard.type(" message")

      // Try to send
      await expect(editor).toBeFocused()
      await expect(editor).toContainText("message")
      const messageBeforeSend = ((await editor.textContent()) ?? "").replace(/\s+/g, " ").trim()
      expect(messageBeforeSend.length).toBeGreaterThan(0)
      await page.keyboard.press("Enter")

      // Message should be sent (exact pre-send editor content)
      await expect(page.getByRole("main").locator("p").filter({ hasText: messageBeforeSend }).first()).toBeVisible({
        timeout: 10000,
      })
    })

    test("should send after clearing and retyping content", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      await page.locator("[contenteditable='true']").click()

      // Type, select all, delete, type again (multiple re-renders)
      await page.keyboard.type("First attempt")
      await page.keyboard.press("Meta+a")
      await page.keyboard.press("Backspace")

      await page.keyboard.type("Second attempt")
      await page.keyboard.press("Meta+a")
      await page.keyboard.press("Backspace")

      await page.keyboard.type("Final message")

      // Try to send
      await page.keyboard.press("Enter")

      // Message should be sent
      await expect(page.locator("p").filter({ hasText: "Final message" }).first()).toBeVisible({ timeout: 5000 })
    })

    test("should send after extended interaction with emoji suggestion", async ({ page }) => {
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

      await page.locator("[contenteditable='true']").click()

      // Type something
      await page.keyboard.type("Great job ")

      // Trigger emoji suggestion
      await page.keyboard.type(":thu")
      await expect(page.locator('[role="listbox"]')).toBeVisible()

      // Escape without selecting
      await page.keyboard.press("Escape")
      await expect(page.locator('[role="listbox"]')).not.toBeVisible()

      // Delete the partial emoji and continue
      await page.keyboard.press("Backspace")
      await page.keyboard.press("Backspace")
      await page.keyboard.press("Backspace")
      await page.keyboard.press("Backspace")
      await page.keyboard.type("everyone!")

      // Try to send
      await page.keyboard.press("Enter")

      // Message should be sent
      await expect(page.locator("p").filter({ hasText: "Great job everyone!" }).first()).toBeVisible({ timeout: 5000 })
    })
  })

  test.describe("preference persistence", () => {
    test("should persist send mode preference across page reload", async ({ page }) => {
      const channelName = `sendmode-persist-${testId}`
      await createChannel(page, channelName, { switchToAll: false })
      await expect(page).toHaveURL(/\/s\/stream_/)

      // Change to cmdEnter mode (non-default)
      await setSendMode(page, "cmdEnter")

      async function waitForCmdEnterComposerReady() {
        await expect(page.getByText(/⌘Enter to send|Ctrl\+Enter to send/).first()).toBeVisible({ timeout: 10000 })
      }

      async function assertCmdEnterMode(messageContent: string) {
        const editor = page.getByRole("textbox", { name: "Message input" })
        const sendButton = page.getByRole("button", { name: "Send", exact: true })

        await waitForCmdEnterComposerReady()
        await expect(editor).toBeVisible({ timeout: 5000 })
        await editor.click()
        await expect(editor).toBeFocused()
        await page.keyboard.insertText(messageContent)
        await expect(editor).toContainText(messageContent)
        await expect(sendButton).toBeEnabled({ timeout: 5000 })

        // Enter should not send in cmdEnter mode.
        await page.keyboard.press("Enter")
        await expect(editor).toContainText(messageContent)
        await expect(sendButton).toBeEnabled({ timeout: 5000 })

        // Completing the send through the button keeps this test focused on
        // preference persistence. Cmd+Enter itself is covered in the dedicated
        // cmdEnter-mode tests above.
        await sendButton.click()
        await expect(
          page.getByRole("main").locator(".message-item").filter({ hasText: messageContent }).first()
        ).toBeVisible({
          timeout: 10000,
        })
      }

      // Verify behavior before reload.
      await assertCmdEnterMode(`CmdEnter-before-reload-${testId}-${Date.now()}`)

      // Reload page
      await page.reload()

      await expect(page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({ timeout: 10000 })

      // Verify behavior after reload - preference should persist.
      await assertCmdEnterMode(`CmdEnter-after-reload-${testId}-${Date.now()}`)
    })
  })
})
