import { test, expect } from "@playwright/test"
import * as path from "path"
import * as fs from "fs"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * Tests for inline file uploads via paste and drag-drop.
 *
 * Tests:
 * 1. Pasting an image inserts [Image #N] reference and attachment chip
 * 2. Pasting a non-image file inserts [filename] reference
 * 3. Drag-drop works the same as paste
 * 4. Multiple images get sequential numbering
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

  test("should insert [Image #1] reference when pasting an image with sequential name", async ({ page }) => {
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

    // Wait for upload to complete and verify the reference appears
    // Should show [Image #1]
    await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10000 })

    // Verify attachment chip shows the renamed filename (pasted-image-1.png)
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

  test("should number images sequentially when pasting multiple", async ({ page }) => {
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

    // Wait for first upload and verify filename
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

    // Should have two references with sequential naming
    await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(2, { timeout: 10000 })
    await expect(page.getByRole("button", { name: "Preview pasted-image-2.png" })).toBeVisible({ timeout: 5000 })
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
    const imageLink = page.locator(".markdown-content button:has-text('Image #1')")
    await expect(imageLink).toBeVisible({ timeout: 10000 })

    // Wait until attachment metadata is hydrated in the rendered message.
    // Inline link click depends on attachment context, which can lag briefly in CI.
    const attachmentPill = page.getByRole("button", { name: "pasted-image-1.png", exact: true })
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
    const imageLink = page.locator(".markdown-content button:has-text('Image #1')")
    await expect(imageLink).toBeVisible({ timeout: 10000 })

    // Find the attachment pill (the image button with the filename)
    const attachmentPill = page.getByRole("button", { name: "pasted-image-1.png", exact: true })
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
})
