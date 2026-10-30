import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, openComposerFixture, pressEditorShortcut, selectAllEditorContent } from "./helpers"

/**
 * Tests for formatting keyboard shortcuts.
 *
 * The editor displays rich text formatting visually (bold, italic, etc.)
 * but exports as markdown when copying or sending.
 *
 * Shortcuts:
 * - Cmd+B → bold (visually styled, exports as **text**)
 * - Cmd+I → italic (visually styled, exports as *text*)
 * - Cmd+Shift+S → strikethrough (visually styled, exports as ~~text~~)
 * - Cmd+Shift+C → code block
 */

test.describe("Formatting Shortcuts", () => {
  test.describe("without selection (cursor only)", () => {
    test.beforeEach(({ page }) => openComposerFixture(page))

    test("Cmd+B should toggle bold and allow typing bold text", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Type some text first
      await page.keyboard.type("hello ")

      // Press Cmd+B to enter bold mode
      await pressEditorShortcut(editor, "b")

      // Type inside bold
      await page.keyboard.type("bold")

      // Press Cmd+B again to exit bold mode
      await pressEditorShortcut(editor, "b")
      await page.keyboard.type(" world")

      // Editor should show styled text with bold element
      await expect(editor.locator("strong")).toContainText("bold")
      await expect(editor).toContainText("hello bold world")
    })

    test("Cmd+I should toggle italic and allow typing italic text", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      await page.keyboard.type("hello ")
      await pressEditorShortcut(editor, "i")
      await page.keyboard.type("italic")
      await pressEditorShortcut(editor, "i")
      await page.keyboard.type(" world")

      await expect(editor.locator("em")).toContainText("italic")
      await expect(editor).toContainText("hello italic world")
    })

    test("Cmd+Shift+S should toggle strikethrough", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      await page.keyboard.type("hello ")
      await pressEditorShortcut(editor, "s", { shift: true })
      await page.keyboard.type("struck")
      await pressEditorShortcut(editor, "s", { shift: true })
      await page.keyboard.type(" world")

      await expect(editor.locator("s")).toContainText("struck")
      await expect(editor).toContainText("hello struck world")
    })

    test("Cmd+Shift+C should create code block", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      await pressEditorShortcut(editor, "c", { shift: true })
      await page.keyboard.type("const x = 1")

      // Should have a code block (pre element)
      await expect(editor.locator("pre")).toBeVisible()
      await expect(editor.locator("pre")).toContainText("const x = 1")
    })
  })

  test.describe("with text selection", () => {
    test.beforeEach(({ page }) => openComposerFixture(page))

    test("Cmd+B should make selected text bold", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Type text and select all with Cmd+A
      await page.keyboard.type("world")
      await selectAllEditorContent(editor)

      // Apply bold
      await pressEditorShortcut(editor, "b")

      // Should wrap the selection in strong
      await expect(editor.locator("strong")).toContainText("world")
    })

    test("Cmd+I should make selected text italic", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      await page.keyboard.type("italic")
      await selectAllEditorContent(editor)

      await pressEditorShortcut(editor, "i")

      await expect(editor.locator("em")).toContainText("italic")
    })

    test("Cmd+Shift+S should strikethrough selected text", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      await page.keyboard.type("text")
      await selectAllEditorContent(editor)

      await pressEditorShortcut(editor, "s", { shift: true })

      await expect(editor.locator("s")).toContainText("text")
    })
  })

  test.describe("shortcuts work after sending message", () => {
    test.beforeEach(async ({ page }) => {
      await loginAndCreateWorkspace(page, "formatting")
      await page.getByRole("button", { name: "+ New Scratchpad" }).click()
      await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })
    })

    test("should work on fresh editor after send", async ({ page }) => {
      const editor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
      await editor.click()

      // Send a message first
      await page.keyboard.type("First message")
      await page.keyboard.press("Meta+Enter")

      // Wait for message to appear
      await expect(page.locator("p").filter({ hasText: "First message" }).first()).toBeVisible({ timeout: 5000 })

      // Wait for the composer to reset before exercising formatting again.
      await expect
        .poll(async () => ((await editor.textContent()) ?? "").trim(), {
          timeout: 10000,
          message: "editor should be cleared after sending a message",
        })
        .toBe("")

      // Now try the shortcut on the cleared editor
      await editor.click()
      await pressEditorShortcut(editor, "b")
      await page.keyboard.type("bold text")

      await expect(editor.locator("strong")).toContainText("bold text")
    })
  })

  test.describe("toolbar buttons produce same result as shortcuts", () => {
    test.beforeEach(({ page }) => openComposerFixture(page))

    test("bold toolbar button should apply bold formatting", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      await page.keyboard.type("hello ")

      // Open the inline formatting toolbar via the Aa button, then click Bold
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Bold" }).click()
      await page.keyboard.type("toolbar")

      await expect(editor.locator("strong")).toContainText("toolbar")
    })

    test("italic toolbar button should apply italic formatting", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      await page.keyboard.type("hello ")

      // Open the inline formatting toolbar via the Aa button, then click Italic
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Italic" }).click()
      await page.keyboard.type("toolbar")

      await expect(editor.locator("em")).toContainText("toolbar")
    })

    test("code toolbar button should apply code formatting", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      await page.keyboard.type("run ")

      // Open the inline formatting toolbar via the Aa button, then click Inline code
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Inline code" }).click()
      await page.keyboard.type("npm")

      await expect(editor.locator("code")).toContainText("npm")
    })
  })
})

test.describe("Ctrl+A and Ctrl+E on Mac", () => {
  test("should move the cursor to the start and end of the line", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" })
    })
    await openComposerFixture(page)

    const editor = page.locator("[contenteditable='true']")
    await expect(editor).toBeVisible({ timeout: 5000 })
    await editor.click()

    await page.keyboard.type("world")
    await page.keyboard.press("Control+a")
    await page.keyboard.type("hello ")
    await page.keyboard.press("Control+e")
    await page.keyboard.type("!")

    await expect(editor).toContainText("hello world!")
    await expect(editor.locator("code")).toHaveCount(0)
  })
})
