import { test, expect } from "@playwright/test"
import * as path from "path"
import * as fs from "fs"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * Tests for inline file uploads via paste and drag-drop.
 *
 * Tests:
 * 1. Pasting an image inserts a filename reference and attachment chip
 * 2. Pasting a non-image file inserts the same filename reference
 * 3. Drag-drop works the same as paste
 * 4. Multiple images keep their filenames
 */

test.describe("Inline File Uploads", () => {
  // Helper to create a test image as a buffer
  function createTestImage(): Buffer {
    // 1x1 red PNG
    const pngData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
      0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4,
      0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])
    return pngData
  }

  test.beforeEach(async ({ page }) => {
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    await loginAndCreateWorkspace(page, "upload-test")

    // Create a channel for testing (creating navigates to it)
    const channelName = `upload-${testId}`
    await createChannel(page, channelName)
  })

  test("should insert the generated filename when pasting an image", async ({ page }) => {
    // Focus the editor
    const editor = page.locator("[contenteditable='true']")
    await editor.click()

    // Create a DataTransfer with an image file
    const imageBuffer = createTestImage()

    // Use evaluate to simulate paste with file (original name will be renamed to pasted-image-1.png)
    await page.evaluate(async (imageData) => {
      const editor = document.querySelector("[contenteditable='true']")
      if (!editor) throw new Error("Editor not found")

      // Create a File from the image data
      const uint8Array = new Uint8Array(imageData)
      const blob = new Blob([uint8Array], { type: "image/png" })
      const file = new File([blob], "screenshot.png", { type: "image/png" })

      // Create DataTransfer with the file
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)

      // Create and dispatch paste event
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      })

      editor.dispatchEvent(pasteEvent)
    }, Array.from(imageBuffer))

    // Wait for upload to complete and verify the reference matches the tray filename.
    const reference = editor.locator("span[data-type='attachment-reference']")
    await expect(reference).toBeVisible({ timeout: 10000 })
    await expect(reference).toContainText("[pasted-image-1.png]")

    // Verify the tray chip shows the renamed filename.
    await expect(page.getByRole("button", { name: "Preview pasted-image-1.png" })).toBeVisible({ timeout: 5000 })
  })

  test("should insert [filename] reference when pasting a non-image file", async ({ page }) => {
    // Focus the editor
    const editor = page.locator("[contenteditable='true']")
    await editor.click()

    // Create a text file
    const textContent = "Hello, world!"

    await page.evaluate(async (content) => {
      const editor = document.querySelector("[contenteditable='true']")
      if (!editor) throw new Error("Editor not found")

      const blob = new Blob([content], { type: "text/plain" })
      const file = new File([blob], "document.txt", { type: "text/plain" })

      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      })

      editor.dispatchEvent(pasteEvent)
    }, textContent)

    // Should show the filename in the reference
    await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10000 })
  })

  test("should keep generated filenames when pasting multiple images", async ({ page }) => {
    const editor = page.locator("[contenteditable='true']")
    await editor.click()

    const imageBuffer = createTestImage()

    // Paste first image
    await page.evaluate(async (imageData) => {
      const editor = document.querySelector("[contenteditable='true']")
      if (!editor) throw new Error("Editor not found")

      const uint8Array = new Uint8Array(imageData)
      const blob = new Blob([uint8Array], { type: "image/png" })
      const file = new File([blob], "image1.png", { type: "image/png" })

      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      })

      editor.dispatchEvent(pasteEvent)
    }, Array.from(imageBuffer))

    // Wait for first upload and verify the tray filename.
    await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole("button", { name: "Preview pasted-image-1.png" })).toBeVisible({ timeout: 5000 })

    // Paste second image
    await page.evaluate(async (imageData) => {
      const editor = document.querySelector("[contenteditable='true']")
      if (!editor) throw new Error("Editor not found")

      const uint8Array = new Uint8Array(imageData)
      const blob = new Blob([uint8Array], { type: "image/png" })
      const file = new File([blob], "image2.png", { type: "image/png" })

      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      })

      editor.dispatchEvent(pasteEvent)
    }, Array.from(imageBuffer))

    // Both inline references use the same generated names shown in the tray.
    const references = editor.locator("span[data-type='attachment-reference']")
    await expect(references).toHaveCount(2, { timeout: 10000 })
    await expect(references.nth(0)).toContainText("[pasted-image-1.png]")
    await expect(references.nth(1)).toContainText("[pasted-image-2.png]")
    await expect(page.getByRole("button", { name: "Preview pasted-image-2.png" })).toBeVisible({ timeout: 5000 })
  })

  test("should keep a mobile multi-pick inline with filenames", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const editor = page.locator("[contenteditable='true']")
    if (!(await editor.isVisible())) {
      await page.getByText("Type a message...").evaluate((element: HTMLElement) => element.click())
    }
    await expect(editor).toBeVisible({ timeout: 5000 })

    const imageBuffer = createTestImage()
    await page.locator('input[type="file"][multiple]').setInputFiles([
      { name: "one.png", mimeType: "image/png", buffer: imageBuffer },
      { name: "two.png", mimeType: "image/png", buffer: imageBuffer },
      { name: "three.png", mimeType: "image/png", buffer: imageBuffer },
    ])

    const references = editor.locator("span[data-type='attachment-reference']")
    await expect(references).toHaveCount(3, { timeout: 10000 })
    await expect(references.nth(0)).toContainText("[one.png]", { timeout: 10000 })
    await expect(references.nth(1)).toContainText("[two.png]", { timeout: 10000 })
    await expect(references.nth(2)).toContainText("[three.png]", { timeout: 10000 })
  })

  test("should open lightbox when clicking image link in sent message", async ({ page }) => {
    const editor = page.locator("[contenteditable='true']")
    await editor.click()

    // Paste an image
    const imageBuffer = createTestImage()
    await page.evaluate(async (imageData) => {
      const editor = document.querySelector("[contenteditable='true']")
      if (!editor) throw new Error("Editor not found")

      const uint8Array = new Uint8Array(imageData)
      const blob = new Blob([uint8Array], { type: "image/png" })
      const file = new File([blob], "screenshot.png", { type: "image/png" })

      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      })

      editor.dispatchEvent(pasteEvent)
    }, Array.from(imageBuffer))

    // Wait for upload to complete (reference visible AND filename chip appears)
    await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole("button", { name: "Preview pasted-image-1.png" })).toBeVisible({ timeout: 5000 })

    // Type some text and send the message
    await editor.type("Check out this image: ")
    await page.getByRole("button", { name: "Send" }).click()

    // Wait for message to appear in timeline (not in editor anymore)
    const imageLink = page.locator(".markdown-content p button:has-text('pasted-image-1.png')")
    await expect(imageLink).toBeVisible({ timeout: 10000 })

    // Wait until attachment metadata is hydrated in the rendered message.
    // Inline link click depends on attachment context, which can lag briefly in CI.
    const attachmentPill = page
      .getByRole("button", { name: "pasted-image-1.png", exact: true })
      .filter({ has: page.locator("img") })
    await expect(attachmentPill).toBeVisible({ timeout: 10000 })

    // Ensure the attachment image has loaded (src attribute is set and not a blob placeholder).
    // The lightbox handler reads the attachment URL from the rendered img element.
    await expect(attachmentPill.locator("img")).toHaveAttribute("src", /https?:|\/api\//, { timeout: 5000 })

    // Click on the image link
    await imageLink.click()

    // Lightbox dialog should open and render the selected image
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await expect(dialog.locator("img[alt='pasted-image-1.png']")).toBeVisible({ timeout: 10000 })
  })

  test("should highlight attachment pill when hovering inline reference", async ({ page }) => {
    const editor = page.locator("[contenteditable='true']")
    await editor.click()

    // Paste an image
    const imageBuffer = createTestImage()
    await page.evaluate(async (imageData) => {
      const editor = document.querySelector("[contenteditable='true']")
      if (!editor) throw new Error("Editor not found")

      const uint8Array = new Uint8Array(imageData)
      const blob = new Blob([uint8Array], { type: "image/png" })
      const file = new File([blob], "screenshot.png", { type: "image/png" })

      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      })

      editor.dispatchEvent(pasteEvent)
    }, Array.from(imageBuffer))

    // Wait for upload to complete (reference visible AND filename chip appears)
    await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole("button", { name: "Preview pasted-image-1.png" })).toBeVisible({ timeout: 5000 })

    // Type some text and send the message
    await editor.type("Hover test: ")
    await page.getByRole("button", { name: "Send" }).click()

    // Wait for message to appear
    const imageLink = page.locator(".markdown-content p button:has-text('pasted-image-1.png')")
    await expect(imageLink).toBeVisible({ timeout: 10000 })

    // Find the attachment pill (the image button with the filename)
    const attachmentPill = page
      .getByRole("button", { name: "pasted-image-1.png", exact: true })
      .filter({ has: page.locator("img") })
    await expect(attachmentPill).toBeVisible({ timeout: 5000 })

    // Before hover: pill should NOT be highlighted
    await expect(attachmentPill).not.toHaveAttribute("data-highlighted", "true")

    // Hover over the inline reference
    await imageLink.hover()

    // After hover: pill SHOULD be highlighted
    await expect(attachmentPill).toHaveAttribute("data-highlighted", "true", { timeout: 1000 })

    // Move mouse away
    await page.mouse.move(0, 0)

    // After unhover: pill should NOT be highlighted anymore
    await expect(attachmentPill).not.toHaveAttribute("data-highlighted", "true", { timeout: 1000 })
  })

  /**
   * The chip is an atom whose `renderHTML` used to carry a content hole, so
   * ProseMirror's clipboard serializer threw ("Content hole not allowed in a
   * leaf node spec") on any selection holding one — nothing reached the
   * clipboard and the chip could not be moved.
   */
  test("should copy and paste an attachment chip", async ({ page }) => {
    const editor = page.locator("[contenteditable='true']")
    await editor.click()

    await page.evaluate(async () => {
      const target = document.querySelector("[contenteditable='true']")
      if (!target) throw new Error("Editor not found")
      const file = new File([new Blob(["Hello, world!"], { type: "text/plain" })], "document.txt", {
        type: "text/plain",
      })
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)
      target.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer })
      )
    })

    await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(1, { timeout: 10000 })

    // Copy the composer's content (chip included), then paste the same
    // flavours back — the real in-app clipboard path, which restores the
    // document from the `data-pm-slice` HTML. Retried until the upload has
    // settled, since a chip still reserving carries a temp id.
    let copied = { html: "", text: "" }
    await expect(async () => {
      await editor.click()
      await page.keyboard.press("Control+a")
      copied = await page.evaluate(() => {
        const target = document.querySelector("[contenteditable='true']")
        if (!target) throw new Error("Editor not found")
        const clipboardData = new DataTransfer()
        target.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }))
        return { html: clipboardData.getData("text/html"), text: clipboardData.getData("text/plain") }
      })
      expect(copied.html).toContain('data-status="uploaded"')
    }).toPass({ timeout: 15000 })
    expect(copied.html).toContain("data-pm-slice")
    expect(copied.html).toContain("attachment-reference")

    // Collapse the select-all before pasting — pasting while it still stands
    // replaces the document instead of duplicating the chip.
    await page.keyboard.press("ArrowRight")
    await page.waitForFunction(() => window.getSelection()?.isCollapsed === true)

    await page.evaluate((flavours) => {
      const target = document.querySelector("[contenteditable='true']")
      if (!target) throw new Error("Editor not found")
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/html", flavours.html)
      clipboardData.setData("text/plain", flavours.text)
      target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
    }, copied)

    await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(2, { timeout: 5000 })

    // Both chips point at the same attachment, so the message carries two
    // references and one attachment.
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page.locator(".markdown-content button:has-text('document.txt')")).toHaveCount(2, { timeout: 10000 })
    await expect(page.getByRole("button", { name: /document\.txt 13 B/ })).toHaveCount(1, { timeout: 10000 })
  })
})
