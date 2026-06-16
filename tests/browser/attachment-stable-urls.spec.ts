import { test, expect } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * Stable attachment content URLs.
 *
 * Inline timeline media must render from the deterministic
 * `/attachments/:id/content?variant=…` endpoint — never from per-session
 * presigned URLs behind a `/attachments/:id/url` round trip. The URL being
 * identical across sessions plus the `immutable` Cache-Control is what lets
 * a warm open serve every image from the browser HTTP cache with zero
 * presign requests and zero media bytes.
 */

// 1x1 red PNG
const TEST_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

const PRESIGN_URL_PATTERN = /\/attachments\/[^/]+\/url(\?|$)/

test.describe("Stable attachment content URLs", () => {
  test("timeline image renders from the deterministic content URL with no presign round trip", async ({ page }) => {
    const presignRequests: string[] = []
    page.on("request", (request) => {
      if (PRESIGN_URL_PATTERN.test(request.url())) presignRequests.push(request.url())
    })

    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    await loginAndCreateWorkspace(page, "media-cache")
    await createChannel(page, `media-${testId}`)

    // Paste an image into the composer and send it.
    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    await page.evaluate(async (imageData) => {
      const editorEl = document.querySelector("[contenteditable='true']")
      if (!editorEl) throw new Error("Editor not found")
      const blob = new Blob([new Uint8Array(imageData)], { type: "image/png" })
      const file = new File([blob], "photo.png", { type: "image/png" })
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)
      editorEl.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer })
      )
    }, Array.from(TEST_PNG))
    await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10000 })

    // Send via the Send button, not Enter: Enter races the async paste insertion
    // (the prod build loses that race and the keystroke no-ops, so nothing sends)
    // — the same reason the encrypted-attachment test uses the button. Wait for
    // the reference to clear so the send has fired before asserting the timeline.
    await page.getByRole("button", { name: "Send", exact: true }).first().click()
    await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(0, { timeout: 15000 })

    // The timeline <img> src must be the deterministic content URL — no async
    // presign before the image can start loading. Assert the element is attached
    // with that src rather than visible: the thumbnail variant is generated
    // lazily, so a not-yet-painted <img> isn't "visible" while the URL strategy
    // under test is already proven by its src plus the raw fetch below.
    const timelineImg = page.locator("img[src*='/content?variant=thumbnail']").first()
    await expect(timelineImg).toBeAttached({ timeout: 15000 })
    const src = await timelineImg.getAttribute("src")
    expect(src).toContain("/api/workspaces/")
    expect(src).toMatch(/\/attachments\/[^/]+\/content\?variant=thumbnail$/)

    // The raw object (always ready, unlike the async thumbnail variant) is
    // served with long-lived immutable caching over the session cookie.
    const rawResponse = await page.request.get(src!.replace("?variant=thumbnail", ""))
    expect(rawResponse.status()).toBe(200)
    expect(rawResponse.headers()["cache-control"]).toBe("private, max-age=31536000, immutable")
    expect(rawResponse.headers()["content-type"]).toBe("image/png")

    // A warm open renders the image again from the same URL — still without a
    // single presign request anywhere in the flow.
    await page.reload()
    await expect(page.locator("img[src*='/content?variant=thumbnail']").first()).toBeAttached({ timeout: 15000 })
    expect(presignRequests).toEqual([])
  })
})
