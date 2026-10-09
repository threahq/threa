import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"
import { DESKTOP_GRID_COLUMNS } from "../../apps/frontend/src/lib/emoji-picker"

// Emoji is inserted as plain text (the unicode character), not a `[data-type='emoji']`
// atom node — the composer switched to editable text so mobile browsers can delete it
// natively. Assert the inserted grapheme rather than the legacy node.
const EMOJI_RE = /\p{Extended_Pictographic}/u

/**
 * Emoji shortcut E2E tests.
 *
 * Tests the Slack-style :shortcode: emoji feature:
 * 1. Emoji picker popup appears when typing ":"
 * 2. Query filters emoji results
 * 3. Selecting emoji inserts it
 * 4. Typing :shortcode: auto-converts to emoji
 */

test.describe("Emoji Shortcuts", () => {
  // Helper to set up a workspace with an editor ready
  async function setupWorkspaceWithEditor(page: import("@playwright/test").Page) {
    await loginAndCreateWorkspace(page, "emoji")

    // Create a scratchpad to get an editor
    await page.getByRole("button", { name: "+ New Scratchpad" }).click()
    await expect(page.getByText(/Type a message|No messages yet/)).toBeVisible({ timeout: 5000 })

    // Get the editor
    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    return editor
  }

  test("should show emoji picker when typing colon", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type ":" to trigger emoji picker
    await page.keyboard.type(":")

    // Emoji grid should appear
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })
  })

  test("should filter emojis when typing query after colon", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type ":" first and wait for grid
    await page.keyboard.type(":")
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Type query to filter (use "grin" which matches "grinning" and "grin")
    await page.keyboard.type("grin")

    // Grid should still be visible with filtered results
    await expect(page.locator("[data-emoji-grid]")).toBeVisible()

    // Should show grinning emoji
    await expect(page.locator("[data-emoji-grid] button").first()).toBeVisible()
  })

  test("should insert emoji when clicking on grid item", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type ":fire" to search
    await page.keyboard.type(":fire")

    // Wait for grid
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Click the first emoji in the grid
    await page.locator("[data-emoji-grid] button").first().click()

    // Emoji should be inserted as text into the editor
    await expect(editor).toContainText(EMOJI_RE)

    // Grid should close after selection
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
  })

  test("should insert emoji when pressing Enter on selected item", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type ":smile" to search
    await page.keyboard.type(":smile")

    // Wait for grid
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Press Enter to select first item
    await page.keyboard.press("Enter")

    // Emoji should be inserted
    await expect(editor).toContainText(EMOJI_RE)

    // Grid should close
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
  })

  test("should insert emoji when pressing Tab on selected item", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type ":heart" to search
    await page.keyboard.type(":heart")

    // Wait for grid
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Press Tab to select first item
    await page.keyboard.press("Tab")

    // Emoji should be inserted
    await expect(editor).toContainText(EMOJI_RE)

    // Grid should close
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
  })

  test("should match emojis by alias shortcodes", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type ":thumbsup" - alias for 👍 (primary shortcode is "+1")
    await page.keyboard.type(":thumbsup")

    // Wait for grid to show the thumbs up emoji
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })
    await expect(page.locator("[data-emoji-grid] button").first()).toBeVisible()

    // Tab also works for selection (Enter works too, tested separately)
    await page.keyboard.press("Tab")

    // Emoji should be inserted
    await expect(editor).toContainText(EMOJI_RE)
  })

  test("should auto-convert :shortcode: when typing closing colon", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type a complete shortcode with closing colon
    await page.keyboard.type(":fire:")

    // Emoji should be auto-converted to the emoji character
    await expect(editor).toContainText(EMOJI_RE, { timeout: 2000 })

    // The emoji picker should NOT be visible (input rule handled it)
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
  })

  test("should close emoji picker when pressing Escape", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type ":" to trigger picker
    await page.keyboard.type(":")

    // Wait for grid
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Press Escape
    await page.keyboard.press("Escape")

    // Grid should close
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
  })

  test("Up/Down commit to the grid, then every arrow moves the highlight", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    await page.keyboard.type(":")
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })
    const buttons = page.locator("[data-emoji-grid] button")
    await expect(buttons.first()).toHaveAttribute("data-selected", "true")

    // Down commits to the grid: one row down at the same column
    await page.keyboard.press("ArrowDown")
    await expect(buttons.nth(DESKTOP_GRID_COLUMNS)).toHaveAttribute("data-selected", "true")

    await page.keyboard.press("ArrowRight")
    await expect(buttons.nth(DESKTOP_GRID_COLUMNS + 1)).toHaveAttribute("data-selected", "true")

    await page.keyboard.press("ArrowLeft")
    await expect(buttons.nth(DESKTOP_GRID_COLUMNS)).toHaveAttribute("data-selected", "true")
    await page.keyboard.press("ArrowUp")
    await expect(buttons.first()).toHaveAttribute("data-selected", "true")

    // ArrowLeft on the first cell moves the caret off the colon and closes the grid
    await page.keyboard.press("ArrowLeft")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
    await page.keyboard.type("x")
    await expect(editor).toHaveText("x:")
  })

  test("Down then Right then Enter inserts the highlighted emoji, not the first", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    await page.keyboard.type(":")
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })
    const buttons = page.locator("[data-emoji-grid] button")
    const first = (await buttons.first().textContent())?.trim() ?? ""

    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowRight")
    const target = buttons.nth(DESKTOP_GRID_COLUMNS + 1)
    await expect(target).toHaveAttribute("data-selected", "true")
    const picked = (await target.textContent())?.trim() ?? ""
    expect(picked).not.toBe(first)

    await page.keyboard.press("Enter")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
    await expect(editor).toHaveText(picked)
  })

  test("Left moves the caret inside the query to fix a typo, and the grid follows", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    await page.keyboard.type(":smle")
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Two Lefts land the caret between "sm" and "le"; the grid stays up on the shorter query
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await expect(page.locator("[data-emoji-grid]")).toBeVisible()
    await page.keyboard.type("i")
    await expect(editor).toHaveText(":smile")
    await expect(page.locator("[data-emoji-grid]")).toBeVisible()

    // End is still the caret's: back to the end of the query, the grid narrows to it
    await page.keyboard.press("End")
    await expect(page.locator("[data-emoji-grid]")).toContainText(":smile:")
    const picked = (await page.locator("[data-emoji-grid] button").first().textContent())?.trim() ?? ""
    await page.keyboard.press("Enter")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
    await expect(editor).toHaveText(picked)
  })

  test("arrowing through existing text never opens the grid at a colon", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    await page.keyboard.type("ratio : 5")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()

    // Caret walks left over "5" and " " and lands right after the colon
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()

    // ...and keeps going: the next ArrowLeft reaches the space before the colon
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.type("x")
    await expect(editor).toHaveText("ratio x: 5")
  })

  test("should send message with Enter when emoji query has no matches (e.g. :) smiley)", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type "hello :)" — the colon triggers the emoji picker, but ")" has no matches
    await page.keyboard.type("hello :)")

    // Emoji grid should NOT be visible (no matches for ")")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()

    // Press Enter — should send the message, not insert a newline
    await page.keyboard.press("Enter")

    // Message should appear in the stream (scoped to main to avoid matching sidebar preview)
    await expect(page.getByRole("main").getByText("hello :)")).toBeVisible({ timeout: 5000 })
  })

  test("should send message with Enter after dismissing emoji picker with Escape", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type ":" to trigger picker
    await page.keyboard.type("hello :")

    // Wait for grid
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Dismiss with Escape
    await page.keyboard.press("Escape")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()

    // Type more text
    await page.keyboard.type(") done")

    // Press Enter — should send
    await page.keyboard.press("Enter")

    // Message should appear (scoped to main to avoid matching sidebar preview)
    await expect(page.getByRole("main").getByText("hello :) done")).toBeVisible({ timeout: 5000 })
  })

  test("should send message ending with :D after dismissing matching emoji picker", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type "nice :D" — :D matches laughing emoji, so the picker opens
    await page.keyboard.type("nice :D")

    // Emoji grid should be visible (D matches emojis)
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Dismiss with Escape
    await page.keyboard.press("Escape")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()

    // Press Enter — should send the message, not insert a newline
    await page.keyboard.press("Enter")

    // Message should appear with the literal :D text (scoped to main to avoid matching sidebar preview)
    await expect(page.getByRole("main").getByText("nice :D")).toBeVisible({ timeout: 5000 })
  })

  test("should keep the picker on screen when the composer leaves little room above it", async ({ page }) => {
    // A phone with the keyboard open leaves ~300px between the stream header and
    // the composer. The picker used to render at its full height regardless, so
    // its top rows sat above the viewport and were unreachable.
    const viewportHeight = 340
    await setupWorkspaceWithEditor(page)
    await page.setViewportSize({ width: 412, height: viewportHeight })

    await page.keyboard.type(":")
    const grid = page.locator("[data-emoji-grid]")
    await expect(grid).toBeVisible({ timeout: 2000 })

    const box = await grid.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight)
  })

  test("should send message with emoji", async ({ page }) => {
    const editor = await setupWorkspaceWithEditor(page)

    // Type emoji shortcode
    await page.keyboard.type(":fire:")

    // Wait for emoji to convert in editor
    await expect(editor).toContainText(EMOJI_RE, { timeout: 2000 })

    // Type additional text after the emoji
    await page.keyboard.type(" Great job!")

    // Send the message
    await page.getByRole("button", { name: "Send" }).click()

    // Message should appear with emoji rendered (stored as :fire: but displayed as 🔥)
    await expect(page.getByRole("main").getByText("🔥 Great job!")).toBeVisible({ timeout: 5000 })
  })
})
