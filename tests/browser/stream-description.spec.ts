import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * Stream descriptions end-to-end: set a rich-text description from stream
 * settings and confirm it lands in the timeline as a "set the description"
 * system event rendered through the normal message-markdown pipeline.
 */
test.describe("Stream description", () => {
  test("setting a description renders a system event in the timeline", async ({ page }) => {
    await loginAndCreateWorkspace(page, "stream-desc")
    await createChannel(page, "design-notes", { switchToAll: false })

    const currentUrl = new URL(page.url())
    const streamUrl = `${currentUrl.origin}${currentUrl.pathname}`
    const streamId = currentUrl.searchParams.get("sid") ?? currentUrl.pathname.match(/\/s\/([^/?]+)/)?.[1]
    expect(streamId).toBeTruthy()

    // Open stream settings → General tab (the description editor lives there).
    await page.goto(`${streamUrl}?stream-settings=general&sid=${streamId}`)

    const dialog = page.getByRole("dialog")
    // The reused message editor; located by the aria-label RichEditor stamps on
    // the contenteditable (matching the proven editor-locator pattern).
    const editor = dialog.locator('[contenteditable="true"][aria-label="Stream description editor"]')
    await expect(editor).toBeVisible({ timeout: 10000 })

    await editor.click()
    await page.keyboard.type("Owned by the design team")
    // Confirm the text actually landed before saving (a focus miss would
    // otherwise leave the editor empty and Save disabled).
    await expect(editor).toContainText("Owned by the design team", { timeout: 5000 })

    const saveButton = dialog.getByRole("button", { name: "Save" })
    await expect(saveButton).toBeEnabled({ timeout: 5000 })

    // Assert the save goes through the workspace router under /api/* (the routing
    // contract in docs/system-overview.md), not a hardcoded backend origin.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => {
          const requestUrl = new URL(r.url())
          return (
            r.request().method() === "PATCH" &&
            requestUrl.pathname.startsWith("/api/") &&
            requestUrl.pathname.includes(`/streams/${streamId}`)
          )
        },
        { timeout: 15000 }
      ),
      saveButton.click(),
    ])
    expect(response.ok()).toBeTruthy()

    // Close settings and reload the timeline (the event is a persisted row).
    await page.goto(streamUrl)

    await expect(page.getByText(/set the description/)).toBeVisible({ timeout: 15000 })
    await expect(page.getByText("Owned by the design team")).toBeVisible({ timeout: 15000 })
  })
})
