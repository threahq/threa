import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

const EMOJI_RE = /\p{Extended_Pictographic}/u

/**
 * Mobile keyboard word-correction vs. trigger popups.
 *
 * When the user taps a keyboard suggestion mid-query (`:fir` → tap "fire"),
 * mobile keyboards replace the word with a leading space because the trigger
 * char is punctuation: the composer ends up with `: fire`. The suggestion
 * popup must survive that single-transaction correction (query "fire"), while
 * a manually typed space must still dismiss it for good.
 */

// Replays what a mobile keyboard does on suggestion tap: mutate the
// contenteditable text node directly, in one DOM change, and move the caret —
// ProseMirror's DOMObserver turns it into a single replacement transaction.
// page.keyboard would produce per-character transactions, which is a different
// (and already working) code path.
async function simulateKeyboardWordCorrection(page: Page, find: string, replace: string) {
  await page.evaluate(
    ([find, replace]) => {
      const editor = document.querySelector("[contenteditable='true']")
      if (!editor) throw new Error("no contenteditable editor found")
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text
        if (candidate.data.includes(find)) node = candidate
      }
      if (!node) throw new Error(`no text node containing ${JSON.stringify(find)}`)
      const index = node.data.lastIndexOf(find)
      node.replaceData(index, find.length, replace)
      const selection = window.getSelection()
      if (!selection) throw new Error("no selection")
      const range = document.createRange()
      range.setStart(node, index + replace.length)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    },
    [find, replace] as const
  )
}

async function setupWorkspaceWithEditor(page: Page, prefix: string) {
  const context = await loginAndCreateWorkspace(page, prefix)
  await page.getByRole("button", { name: "+ New Scratchpad" }).click()
  await expect(page.getByText(/Type a message|No messages yet/)).toBeVisible({ timeout: 5000 })
  const editor = page.locator("[contenteditable='true']")
  await editor.click()
  return { editor, ...context }
}

test.describe("Keyboard word-correction in trigger popups", () => {
  test("emoji picker survives a word-correction with leading space and picks the emoji", async ({ page }) => {
    const { editor } = await setupWorkspaceWithEditor(page, "kbemoji")

    await page.keyboard.type(":fir")
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // Keyboard replaces the fat-fingered "fir" with " fire" in one transaction.
    await simulateKeyboardWordCorrection(page, ":fir", ": fire")
    await expect(editor).toContainText(": fire")

    // Picker stays open, filtered by the corrected word.
    await expect(page.locator("[data-emoji-grid]")).toBeVisible()
    await expect(page.locator("[data-emoji-grid] button[aria-label=':fire:']").first()).toBeVisible()

    // Picking replaces the whole `: fire` range, space included.
    await page.keyboard.press("Enter")
    await expect(editor).toContainText(EMOJI_RE)
    await expect(editor).not.toContainText(":")
    await expect(editor).not.toContainText("fire")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
  })

  test("manually typed space after the trigger still dismisses the picker for good", async ({ page }) => {
    await setupWorkspaceWithEditor(page, "kbspace")

    await page.keyboard.type(":")
    await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

    // A typed space closes the picker on its own transaction...
    await page.keyboard.type(" ")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()

    // ...so continuing to type a word after `: ` must NOT reopen it.
    await page.keyboard.type("fire")
    await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
  })

  test("mention popup survives a word-correction with leading space and picks the mention", async ({ page }) => {
    const { editor, name } = await setupWorkspaceWithEditor(page, "kbmention")
    const [firstName] = name.split(" ")

    const partial = firstName.slice(0, firstName.length - 2)
    await page.keyboard.type(`@${partial}`)
    await expect(page.getByRole("listbox")).toBeVisible({ timeout: 2000 })

    await simulateKeyboardWordCorrection(page, `@${partial}`, `@ ${firstName}`)
    await expect(editor).toContainText(`@ ${firstName}`)

    await expect(page.getByRole("listbox")).toBeVisible()
    await expect(page.getByRole("option").first()).toContainText(firstName)

    await page.keyboard.press("Enter")
    await expect(editor.locator("[data-type='mention']")).toBeVisible()
    await expect(editor).not.toContainText(`@ ${firstName}`)
    await expect(page.getByRole("listbox")).not.toBeVisible()
  })
})
