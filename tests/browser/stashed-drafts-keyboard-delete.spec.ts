import { test, expect } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * The drafts pile is fully operable without a mouse: the stash shortcut on an
 * empty composer opens it, Delete on a focused row asks to delete that draft,
 * Enter confirms, and focus lands back in the pile on the neighbouring row —
 * or in the composer once the pile is empty. Runs in a real browser because
 * jsdom has no exit animation: there the confirm unmounts at once, while in a
 * browser its focus trap outlives the close and takes focus back from a pile
 * reopened too early.
 */
test("stashed drafts are deleted from the keyboard without losing focus", async ({ page }) => {
  await loginAndCreateWorkspace(page, "draft-keys")
  await createChannel(page, `draft-keys-${Date.now().toString(36)}`, { switchToAll: false })

  const editor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
  await expect(editor).toBeFocused({ timeout: 5000 })

  const trigger = page.getByRole("button", { name: /^Drafts/ })
  const bodies = ["oldest stashed body", "middle stashed body", "newest stashed body"]
  for (const [index, body] of bodies.entries()) {
    await page.keyboard.type(body)
    await page.keyboard.press("ControlOrMeta+s")
    await expect(editor).toHaveText("")
    await expect(trigger).toHaveAccessibleName(`Drafts (${index + 1} saved)`)
  }

  const row = (body: string) => page.locator("[data-draft-row]").filter({ hasText: body })
  const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Delete" })

  // Nothing to stash: the same shortcut opens the pile, newest row first.
  await page.keyboard.press("ControlOrMeta+s")
  await expect(row("newest stashed body")).toBeFocused()

  await page.keyboard.press("ArrowDown")
  await expect(row("middle stashed body")).toBeFocused()

  // Cancelling the confirm returns to the row it was asked about.
  await page.keyboard.press("Delete")
  await expect(confirm).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(row("middle stashed body")).toBeFocused()
  await expect(page.locator("[data-draft-row]")).toHaveCount(3)

  // Confirming lands on the row that took the deleted one's place. Enter held
  // past the confirm auto-repeats onto that row and must not restore it.
  await page.keyboard.press("Delete")
  await expect(confirm).toBeFocused()
  await page.keyboard.down("Enter")
  await expect(row("middle stashed body")).toHaveCount(0)
  await expect(row("oldest stashed body")).toBeFocused()
  await page.keyboard.down("Enter")
  await page.keyboard.up("Enter")
  await expect(row("oldest stashed body")).toBeFocused()
  await expect(editor).toHaveText("")

  // Deleting the last row falls back to the one above it.
  await page.keyboard.press("Delete")
  await expect(confirm).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(row("oldest stashed body")).toHaveCount(0)
  await expect(row("newest stashed body")).toBeFocused()

  // An emptied pile closes and hands focus to the composer.
  await page.keyboard.press("Delete")
  await expect(confirm).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator("[data-draft-row]")).toHaveCount(0)
  await expect(editor).toBeFocused()
  await expect(trigger).toHaveAccessibleName("Drafts")

  await page.keyboard.type("still typing")
  await expect(editor).toHaveText("still typing")
})
