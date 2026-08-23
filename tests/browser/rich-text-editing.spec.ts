import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, pressEditorShortcut, selectAllEditorContent } from "./helpers"

/**
 * Tests for Linear-style rich text editing.
 *
 * Features tested:
 * - Inline formatting via markdown input rules (**bold**, *italic*, etc.)
 * - Keyboard shortcuts toggle marks (Cmd+B, Cmd+I, etc.)
 * - Block formatting (lists, code blocks, blockquotes, headings)
 * - Tab/Shift+Tab for list indentation
 * - Double-enter to exit blocks
 * - Copy serializes to markdown, paste parses markdown
 * - Send modes still work with rich text
 */

async function placeCursorInText(page: import("@playwright/test").Page, text: string, offset = 0) {
  await page.evaluate(
    ({ offset, text }) => {
      const editor = document.querySelector<HTMLElement>("[contenteditable='true']")
      if (!editor) {
        throw new Error("Editor not found")
      }

      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let current: Node | null

      while ((current = walker.nextNode())) {
        const value = current.textContent ?? ""
        const index = value.indexOf(text)
        if (index === -1) {
          continue
        }

        const range = document.createRange()
        range.setStart(current, index + offset)
        range.collapse(true)

        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        editor.focus()
        return
      }

      throw new Error(`Could not place cursor inside text: ${text}`)
    },
    { offset, text }
  )
}

async function selectTextRange(
  page: import("@playwright/test").Page,
  startText: string,
  endText: string,
  endOffset = endText.length
) {
  await page.evaluate(
    ({ endOffset, endText, startText }) => {
      const editor = document.querySelector<HTMLElement>("[contenteditable='true']")
      if (!editor) {
        throw new Error("Editor not found")
      }

      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let current: Node | null
      let startNode: Node | null = null
      let endNode: Node | null = null
      let startOffset = 0
      let resolvedEndOffset = 0

      while ((current = walker.nextNode())) {
        const value = current.textContent ?? ""

        if (!startNode) {
          const index = value.indexOf(startText)
          if (index !== -1) {
            startNode = current
            startOffset = index
            endNode = null
            resolvedEndOffset = 0
          }
        }

        if (!startNode) {
          continue
        }

        const searchStart = current === startNode ? startOffset : 0
        const endIndex = value.indexOf(endText, searchStart)
        if (endIndex !== -1) {
          endNode = current
          resolvedEndOffset = endIndex + endOffset
          break
        }
      }

      if (!startNode || !endNode) {
        throw new Error(`Could not select range from "${startText}" to "${endText}"`)
      }

      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, resolvedEndOffset)

      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      editor.focus()
    },
    { endOffset, endText, startText }
  )

  await expect
    .poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ""), {
      timeout: 5000,
      message: `selection should include "${startText}" through "${endText}"`,
    })
    .toContain(startText)
  await expect
    .poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ""), {
      timeout: 5000,
      message: `selection should include "${endText}"`,
    })
    .toContain(endText)
}

async function dispatchBeforeInput(
  page: import("@playwright/test").Page,
  inputType: "insertParagraph" | "insertLineBreak" = "insertParagraph"
) {
  await page.evaluate((type) => {
    const editor = document.querySelector<HTMLElement>("[contenteditable='true']")
    if (!editor) {
      throw new Error("Editor not found")
    }

    editor.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: type,
      })
    )
  }, inputType)
}

// Replays the shape of Gboard's enter-and-pick: the autocorrect lands in the
// DOM and the newline's `beforeinput` fires in the same task. Desktop Chromium
// never arms ProseMirror's Android deferred flush, so this proves the keydown
// re-dispatch path end to end, not the `forceFlush` timing (that is the
// multiline-blocks unit test).
async function autocorrectThenEnter(page: import("@playwright/test").Page, find: string, replace: string) {
  await page.evaluate(
    ([find, replace]) => {
      const editor = document.querySelector<HTMLElement>("[contenteditable='true']")
      if (!editor) throw new Error("Editor not found")
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text
        if (candidate.data.includes(find)) node = candidate
      }
      if (!node) throw new Error(`no text node containing ${JSON.stringify(find)}`)
      const index = node.data.lastIndexOf(find)
      node.replaceData(index, find.length, replace)
      const range = document.createRange()
      range.setStart(node, index + replace.length)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      editor.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertParagraph" })
      )
    },
    [find, replace] as const
  )
}

async function pastePlainText(page: import("@playwright/test").Page, text: string) {
  await page.evaluate((value) => {
    const editor = document.querySelector<HTMLElement>("[contenteditable='true']")
    if (!editor) {
      throw new Error("Editor not found")
    }

    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", value)
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

async function focusMobileComposer(page: import("@playwright/test").Page) {
  await page.getByText("Type a message...").evaluate((element: HTMLElement) => element.click())
  await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })
}

test.describe("Rich Text Editing", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "richtext")

    // Create a scratchpad for testing
    const newScratchpadButton = page.getByRole("button", { name: "+ New Scratchpad" })
    if ((page.viewportSize()?.width ?? 0) < 640) {
      await newScratchpadButton.evaluate((button: HTMLElement) => button.click())
    } else {
      await newScratchpadButton.click()
    }

    if ((page.viewportSize()?.width ?? 0) < 640) {
      await expect(page.getByText("Type a message...")).toBeVisible({ timeout: 5000 })
      return
    }

    await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })
  })

  test.describe("Inline Formatting - Input Rules", () => {
    test("typing **text** converts to bold", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("**bold text**")

      // Verify styled bold, no raw asterisks visible
      await expect(editor.locator("strong")).toHaveText("bold text")
      await expect(editor).not.toContainText("**")
    })

    test("typing *text* converts to italic", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("*italic text*")

      await expect(editor.locator("em")).toHaveText("italic text")
      await expect(editor).not.toContainText("*italic")
    })

    test("typing ~~text~~ converts to strikethrough", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("~~struck text~~")

      await expect(editor.locator("s")).toHaveText("struck text")
      await expect(editor).not.toContainText("~~")
    })

    test("typing `code` converts to inline code", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("`inline code`")

      await expect(editor.locator("code")).toHaveText("inline code")
      // Raw backticks should be gone
      await expect(editor).not.toContainText("`inline")
    })
  })

  test.describe("Inline Formatting - Keyboard Shortcuts", () => {
    test("Cmd+B toggles bold on selection", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("some text")

      // Select all and apply bold
      await selectAllEditorContent(editor)
      await pressEditorShortcut(editor, "b")

      await expect(editor.locator("strong")).toHaveText("some text")

      // Toggle off
      await selectAllEditorContent(editor)
      await pressEditorShortcut(editor, "b")
      await expect(editor.locator("strong")).not.toBeVisible()
    })

    test("Cmd+I toggles italic on selection", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("text to italicize")

      await selectAllEditorContent(editor)
      await pressEditorShortcut(editor, "i")

      await expect(editor.locator("em")).toHaveText("text to italicize")
    })

    test("Cmd+E toggles inline code on selection", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("variable_name")

      await selectAllEditorContent(editor)
      await pressEditorShortcut(editor, "e")

      await expect(editor.locator("code")).toHaveText("variable_name")
    })

    test("Cmd+Shift+S toggles strikethrough", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("crossed out")

      await selectAllEditorContent(editor)
      await pressEditorShortcut(editor, "s", { shift: true })

      await expect(editor.locator("s")).toHaveText("crossed out")
    })
  })

  test.describe("Block Formatting - Lists", () => {
    test("typing '- ' creates bullet list", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("- first item")

      await expect(editor.locator("ul li")).toContainText("first item")
    })

    test("typing '1. ' creates numbered list", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("1. first item")

      await expect(editor.locator("ol li")).toContainText("first item")
    })

    test("Shift+Enter in list creates new item", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("- item one")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("item two")

      await expect(editor.locator("ul li")).toHaveCount(2)
    })

    test("Shift+Enter on empty list item exits list", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("- item")
      await page.keyboard.press("Shift+Enter")
      // Empty list item
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("not in list")

      // Should have exited the list - list has 1 item, and paragraph with text exists
      await expect(editor.locator("ul li")).toHaveCount(1)
      await expect(editor.getByText("not in list")).toBeVisible()
      // The text should NOT be inside the list
      await expect(editor.locator("ul li").filter({ hasText: "not in list" })).toHaveCount(0)
    })

    test("Tab indents list item", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("- parent")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("child")
      await page.keyboard.press("Tab")

      // Verify nested list structure
      await expect(editor.locator("ul ul li")).toContainText("child")
    })

    test("Shift+Tab outdents list item", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("- parent")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("child")
      await page.keyboard.press("Tab") // Indent
      await page.keyboard.press("Shift+Tab") // Outdent

      // Verify back to top level
      await expect(editor.locator("ul > li")).toHaveCount(2)
    })
  })

  test.describe("Block Formatting - Code Blocks", () => {
    test("typing ``` + space creates code block", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      // TipTap input rule triggers on space after backticks
      await page.keyboard.type("``` ")
      await page.keyboard.type("const x = 1")

      await expect(editor.locator("pre code")).toContainText("const x = 1")
    })

    test("typing ``` + Shift+Enter creates code block", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      // Shift+Enter triggers code block creation just like Enter would in cmdEnter mode
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("const y = 2")

      await expect(editor.locator("pre code")).toContainText("const y = 2")
    })

    test("Tab in code block inserts spaces", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      // TipTap input rule triggers on space after backticks
      await page.keyboard.type("``` ")
      await page.keyboard.press("Tab")
      await page.keyboard.type("indented")

      // Verify indentation (2 spaces)
      await expect(editor.locator("pre code")).toContainText("  indented")
    })

    test("Cmd+Shift+C toggles code block", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("some code")
      await selectAllEditorContent(editor)
      await pressEditorShortcut(editor, "c", { shift: true })

      await expect(editor.locator("pre")).toBeVisible()
    })
  })

  test.describe("Block Formatting - Blockquotes", () => {
    test("typing '> ' creates blockquote", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("> quoted text")

      await expect(editor.locator("blockquote")).toContainText("quoted text")
    })

    test("Shift+Enter adds line within blockquote", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("> line one")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line two")

      // Both lines should be within the blockquote
      await expect(editor.locator("blockquote")).toContainText("line one")
      await expect(editor.locator("blockquote")).toContainText("line two")
    })
  })

  test.describe("Block Formatting - Headings", () => {
    test("typing '# ' creates H1", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("# Heading One")

      await expect(editor.locator("h1")).toHaveText("Heading One")
    })

    test("typing '## ' creates H2", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("## Heading Two")

      await expect(editor.locator("h2")).toHaveText("Heading Two")
    })

    test("typing '### ' creates H3", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("### Heading Three")

      await expect(editor.locator("h3")).toHaveText("Heading Three")
    })

    // Note: backspace-at-start-of-heading is not supported by TipTap's Heading extension.
    // Users can use Cmd+Shift+0 or the toolbar to convert headings to paragraphs.
  })

  test.describe("Toolbar Buttons", () => {
    test("bold button toggles bold", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      const boldButton = page.getByRole("button", { name: "Bold" }).first()
      await editor.click()
      await page.keyboard.type("text")
      await selectAllEditorContent(editor)

      // Click bold button
      await expect(boldButton).toBeVisible()
      await boldButton.click()
      await expect(editor.locator("strong")).toHaveText("text")
    })

    test("bullet list button creates list", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("item")

      // Open the inline toolbar, then click bullet list.
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Bullet list" }).click()
      await expect(editor.locator("ul li")).toContainText("item")
    })

    test("quote button creates blockquote", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("quoted")

      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Quote" }).click()
      await expect(editor.locator("blockquote")).toContainText("quoted")
    })

    test("code block button wraps selected paragraphs in a single code block", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      await selectTextRange(page, "line 1", "line 3")
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Code block" }).click()

      await expect(editor.locator("pre")).toHaveCount(1)
      await expect.poll(async () => await editor.locator("pre code").textContent()).toBe("line 1\nline 2\nline 3")
    })

    test("quote button wraps selected paragraphs in a single blockquote", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      await selectTextRange(page, "line 1", "line 3")
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Quote" }).click()

      await expect(editor.locator("blockquote")).toHaveCount(1)
      await expect(editor.locator("blockquote p")).toHaveCount(3)
      await expect(editor.locator("blockquote")).toContainText("line 1")
      await expect(editor.locator("blockquote")).toContainText("line 2")
      await expect(editor.locator("blockquote")).toContainText("line 3")
    })

    test("code block button unwraps the full block when toggled off from the first line", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      await placeCursorInText(page, "line 1", 2)
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Code block" }).click()

      await expect(editor.locator("pre")).toHaveCount(0)
      await expect(editor.locator("p").filter({ hasText: "line 1" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 3" })).toHaveCount(1)
    })

    test("code block button unwraps only the current line when toggled off below the first line", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      await placeCursorInText(page, "line 2", 2)
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Code block" }).click()

      await expect(editor.locator("pre")).toHaveCount(2)
      await expect(editor.locator("pre").nth(0)).toContainText("line 1")
      await expect(editor.locator("pre").nth(1)).toContainText("line 3")
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(1)
      await expect(editor.locator("pre").filter({ hasText: "line 2" })).toHaveCount(0)
    })

    test("code block button unwraps only the selected lines", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      await selectTextRange(page, "line 2", "line 3")
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Code block" }).click()

      await expect(editor.locator("pre")).toHaveCount(1)
      await expect(editor.locator("pre")).toContainText("line 1")
      await expect(editor.locator("pre")).not.toContainText("line 2")
      await expect(editor.locator("pre")).not.toContainText("line 3")
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 3" })).toHaveCount(1)
    })

    test("code block button unwraps selected adjacent code blocks", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      for (const line of ["line 1", "line 2", "line 3"]) {
        await selectTextRange(page, line, line)
        await page.getByRole("button", { name: "Formatting", exact: true }).click()
        await page.getByRole("button", { name: "Code block" }).click()
      }

      await expect(editor.locator("pre")).toHaveCount(3)

      await selectTextRange(page, "line 1", "line 3")
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Code block" }).click()

      await expect(editor.locator("pre")).toHaveCount(0)
      await expect(editor.locator("p").filter({ hasText: "line 1" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 3" })).toHaveCount(1)
    })

    test("quote button unwraps the full block when toggled off from the first line", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("> line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      await placeCursorInText(page, "line 1", 2)
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Quote" }).click()

      await expect(editor.locator("blockquote")).toHaveCount(0)
      await expect(editor.locator("p").filter({ hasText: "line 1" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 3" })).toHaveCount(1)
    })

    test("quote button unwraps only the current quoted line when toggled off below the first line", async ({
      page,
    }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("> line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      await placeCursorInText(page, "line 2", 2)
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Quote" }).click()

      await expect(editor.locator("blockquote")).toHaveCount(2)
      await expect(editor.locator("blockquote").nth(0)).toContainText("line 1")
      await expect(editor.locator("blockquote").nth(1)).toContainText("line 3")
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(1)
      await expect(editor.locator("blockquote").filter({ hasText: "line 2" })).toHaveCount(0)
    })

    test("quote button unwraps only the selected quoted lines", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("> line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      await selectTextRange(page, "line 2", "line 3")
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Quote" }).click()

      await expect(editor.locator("blockquote")).toHaveCount(1)
      await expect(editor.locator("blockquote")).toContainText("line 1")
      await expect(editor.locator("blockquote")).not.toContainText("line 2")
      await expect(editor.locator("blockquote")).not.toContainText("line 3")
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 3" })).toHaveCount(1)
    })

    test("quote button unwraps selected adjacent blockquotes", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      for (const line of ["line 1", "line 2", "line 3"]) {
        await selectTextRange(page, line, line)
        await page.getByRole("button", { name: "Formatting", exact: true }).click()
        await page.getByRole("button", { name: "Quote" }).click()
      }

      await expect(editor.locator("blockquote")).toHaveCount(3)

      await selectTextRange(page, "line 1", "line 3")
      await page.getByRole("button", { name: "Formatting", exact: true }).click()
      await page.getByRole("button", { name: "Quote" }).click()

      await expect(editor.locator("blockquote")).toHaveCount(0)
      await expect(editor.locator("p").filter({ hasText: "line 1" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(1)
      await expect(editor.locator("p").filter({ hasText: "line 3" })).toHaveCount(1)
    })
  })

  test.describe("Send Mode Integration", () => {
    test("Enter sends in enter-mode (formatting preserved)", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      // Create bold text
      await page.keyboard.type("**bold message**")
      await expect(editor.locator("strong")).toBeVisible()

      // Enter should send
      await page.keyboard.press("Enter")

      // Message should appear in timeline (sent successfully)
      await expect(page.locator("p").filter({ hasText: "bold message" }).first()).toBeVisible({ timeout: 5000 })
    })

    test("Shift+Enter creates newline without sending", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")

      // Both lines should be in editor
      await expect(editor).toContainText("line 1")
      await expect(editor).toContainText("line 2")

      // Not sent - placeholder still visible
      await expect(page.getByText("Start a conversation")).toBeVisible()
    })
  })

  test.describe("Copy/Paste", () => {
    test("paste markdown converts to styled text", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Paste markdown via clipboard
      await page.evaluate(() => {
        const clipboardData = new DataTransfer()
        clipboardData.setData("text/plain", "**pasted bold** and `code`")
        const event = new ClipboardEvent("paste", { clipboardData, bubbles: true })
        document.querySelector("[contenteditable='true']")?.dispatchEvent(event)
      })

      await expect(editor.locator("strong")).toHaveText("pasted bold")
      await expect(editor.locator("code")).toHaveText("code")
    })

    test("pasting multiline text inside a code block keeps it inside the same block", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("seed")

      await selectTextRange(page, "seed", "seed")
      await pastePlainText(page, "line 1\nline 2")

      await expect(editor.locator("pre")).toHaveCount(1)
      await expect(editor.locator("pre code")).toContainText("line 1")
      await expect(editor.locator("pre code")).toContainText("line 2")
      await expect(editor.locator("p").filter({ hasText: "line 1" })).toHaveCount(0)
    })

    test("pasting multiline text inside a blockquote keeps it inside the same quote", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("> seed")

      await selectTextRange(page, "seed", "seed")
      await pastePlainText(page, "line 1\nline 2")

      await expect(editor.locator("blockquote")).toHaveCount(1)
      await expect(editor.locator("blockquote")).toContainText("line 1")
      await expect(editor.locator("blockquote")).toContainText("line 2")
      await expect(editor.locator(":scope > p").filter({ hasText: "line 1" })).toHaveCount(0)
    })
  })

  test.describe("Unified Newlines", () => {
    test("Shift+Enter creates new paragraph (unified with Enter in cmdEnter mode)", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // In default enter mode, Shift+Enter should create new paragraph
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      // All three lines should be in separate paragraphs
      await expect(editor.locator("p")).toHaveCount(3)
      await expect(editor).toContainText("line 1")
      await expect(editor).toContainText("line 2")
      await expect(editor).toContainText("line 3")
    })
  })

  test.describe("VS Code-style Tab Indentation", () => {
    test("Tab with multi-line selection indents all lines (preserves content)", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Create multi-line content
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 3")

      // Select all and press Tab
      await page.keyboard.press("ControlOrMeta+a")
      await page.keyboard.press("Tab")

      // All lines should still exist (not replaced with tab)
      await expect(editor).toContainText("line 1")
      await expect(editor).toContainText("line 2")
      await expect(editor).toContainText("line 3")
    })

    test("Tab in code block with multi-line selection indents all lines", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Create a code block with content
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("const a = 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("const b = 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("const c = 3")

      // Select all content in code block (Cmd+A should select within code block first)
      await page.keyboard.press("ControlOrMeta+a")
      await page.keyboard.press("Tab")

      // All lines should be indented but still exist
      const codeContent = await editor.locator("pre code").textContent()
      expect(codeContent).toContain("const a = 1")
      expect(codeContent).toContain("const b = 2")
      expect(codeContent).toContain("const c = 3")
    })

    test("Shift+Tab with multi-line selection dedents all lines", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Create indented multi-line content in code block
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("\tconst a = 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("\tconst b = 2")

      // Select all and dedent
      await page.keyboard.press("ControlOrMeta+a")
      await page.keyboard.press("Shift+Tab")

      // Content should be dedented but still exist
      const codeContent = await editor.locator("pre code").textContent()
      expect(codeContent).toContain("const a = 1")
      expect(codeContent).toContain("const b = 2")
    })
  })

  test.describe("Shift+Enter in Lists", () => {
    test("Shift+Enter in list item creates new item (same as Enter)", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Create a list
      await page.keyboard.type("- item 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("item 2")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("item 3")

      // Should have 3 list items
      await expect(editor.locator("ul li")).toHaveCount(3)
      await expect(editor).toContainText("item 1")
      await expect(editor).toContainText("item 2")
      await expect(editor).toContainText("item 3")
    })
  })

  test.describe("Code Block with Shift+Enter", () => {
    test("Shift+Enter after ``` creates code block (same as Enter)", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()

      // Type ``` and press Shift+Enter (should create code block just like Enter)
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("code content")

      await expect(editor.locator("pre code")).toContainText("code content")
    })
  })

  test.describe("Desktop Multiline Blocks", () => {
    test("Shift+Enter twice keeps subsequent code inside the current code block", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")

      await expect(editor.locator("pre")).toHaveCount(1)
      await expect(editor.locator("pre")).toContainText("line 1")
      await expect(editor.locator("pre")).toContainText("line 2")
      await expect(editor.locator("p").filter({ hasText: "line 2" })).toHaveCount(0)
    })

    test("Shift+Enter twice keeps subsequent text inside the current blockquote", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("> line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("line 2")

      await expect(editor.locator("blockquote")).toHaveCount(1)
      await expect(editor.locator("blockquote")).toContainText("line 1")
      await expect(editor.locator("blockquote")).toContainText("line 2")
      await expect(editor.locator(":scope > p").filter({ hasText: "line 2" })).toHaveCount(0)
    })

    test("Shift+Enter exits a code block on the third newline", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("```")
      await page.keyboard.press("Shift+Enter")
      await expect(editor.locator("pre")).toHaveCount(1)

      await page.keyboard.type("line 1")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("outside")

      await expect(editor.locator("pre")).toHaveCount(1)
      await expect(editor.locator("pre")).toContainText("line 1")
      await expect(editor.locator("pre")).not.toContainText("outside")
      await expect.poll(async () => await editor.locator("pre code").textContent()).toBe("line 1")
      await expect(editor.locator("p").filter({ hasText: "outside" })).toHaveCount(1)
    })

    test("Shift+Enter exits a blockquote on the third newline", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await editor.click()
      await page.keyboard.type("> quoted line")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.press("Shift+Enter")
      await page.keyboard.type("outside")

      await expect(editor.locator("blockquote")).toHaveCount(1)
      await expect(editor.locator("blockquote")).toContainText("quoted line")
      await expect(editor.locator("blockquote")).not.toContainText("outside")
      await expect(editor.locator("p").filter({ hasText: "outside" })).toHaveCount(1)
    })
  })

  test.describe("Mobile Multiline Blocks", () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test("beforeinput exits a code block on the third newline", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await focusMobileComposer(page)
      await page.keyboard.type("```")
      await dispatchBeforeInput(page)
      await expect(editor.locator("pre")).toHaveCount(1)

      await page.keyboard.type("line 1")
      await dispatchBeforeInput(page)
      await dispatchBeforeInput(page)
      await dispatchBeforeInput(page)
      await page.keyboard.type("outside")

      await expect(editor.locator("pre")).toHaveCount(1)
      await expect(editor.locator("pre")).toContainText("line 1")
      await expect(editor.locator("pre")).not.toContainText("outside")
      await expect.poll(async () => await editor.locator("pre code").textContent()).toBe("line 1")
      await expect(editor.locator("p").filter({ hasText: "outside" })).toHaveCount(1)
    })

    test("beforeinput exits a blockquote on the third newline", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await focusMobileComposer(page)
      await page.keyboard.type("> quoted line")
      await dispatchBeforeInput(page)
      await dispatchBeforeInput(page)
      await dispatchBeforeInput(page)
      await page.keyboard.type("outside")

      await expect(editor.locator("blockquote")).toHaveCount(1)
      await expect(editor.locator("blockquote")).toContainText("quoted line")
      await expect(editor.locator("blockquote")).not.toContainText("outside")
      await expect(editor.locator("p").filter({ hasText: "outside" })).toHaveCount(1)
    })

    test("beforeinput Enter keeps the word the keyboard autocorrected in the same task", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await focusMobileComposer(page)
      await page.keyboard.type("- List items steugge")
      await expect(editor.locator("li")).toHaveCount(1)

      await autocorrectThenEnter(page, "steugge", "struggle")

      await expect(editor.locator("li")).toHaveCount(2)
      await expect(editor.locator("li").first()).toHaveText("List items struggle")
      await expect(editor.locator("li").nth(1)).toHaveText("")
    })

    // The synthetic `beforeinput` inserts nothing in a real browser, so these
    // two specs prove the handler hands Enter to the popover (red before the
    // fix: nothing happened), not that a native newline is suppressed.
    test("beforeinput Enter picks the highlighted emoji instead of inserting a newline", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await focusMobileComposer(page)
      await page.keyboard.type(":fir")
      await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

      await dispatchBeforeInput(page)

      await expect(editor).toContainText(/\p{Extended_Pictographic}/u)
      await expect(editor).not.toContainText("fir")
      await expect(editor.locator("p")).toHaveCount(1)
      await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
    })

    test("beforeinput Enter picks the emoji even when the keyboard autocorrects the query first", async ({ page }) => {
      const editor = page.locator("[contenteditable='true']")
      await focusMobileComposer(page)
      await page.keyboard.type(":upsid")
      await expect(page.locator("[data-emoji-grid]")).toBeVisible({ timeout: 2000 })

      await autocorrectThenEnter(page, "upsid", "upside")

      await expect(editor).toContainText(/\p{Extended_Pictographic}/u)
      await expect(editor).not.toContainText("upsid")
      await expect(editor.locator("p")).toHaveCount(1)
      await expect(page.locator("[data-emoji-grid]")).not.toBeVisible()
    })
  })
})
