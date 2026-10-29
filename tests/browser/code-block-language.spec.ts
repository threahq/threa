import { test, expect, type Page, type Locator } from "@playwright/test"
import {
  anchorRow,
  createChannelViaApi,
  createDocViaApi,
  docEditor,
  expectApiOk,
  loginAndCreateWorkspace,
  openChannel,
  workspaceIdFromUrl,
} from "./helpers"

/**
 * An editor code block carries its language as a chip: picking from the list
 * re-colours the draft with the same Shiki theme the sent message uses, sends
 * the pick as the fence, and in a doc syncs to every open copy. Layout, real
 * focus, the touch drawer and Yjs are what jsdom cannot answer.
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 800 }

function composerEditor(page: Page): Locator {
  return page.getByRole("main").locator("[contenteditable='true']").first()
}

async function openScratchpad(page: Page): Promise<string> {
  await loginAndCreateWorkspace(page, "code-language")
  const workspaceId = workspaceIdFromUrl(page)
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, { data: { type: "scratchpad" } })
  await expectApiOk(response, "Create scratchpad")
  const { stream } = (await response.json()) as { stream: { id: string } }
  const url = `/w/${workspaceId}/s/${stream.id}`
  await page.goto(url)
  await expect(composerEditor(page)).toBeVisible({ timeout: 10_000 })
  return url
}

/** Colour of the first token whose text is `text`, resolved through the `.shiki` rules. */
function tokenColor(editor: Locator, text: string): Promise<string | null> {
  return editor
    .locator("pre code span", { hasText: text })
    .first()
    .evaluate((span) => getComputedStyle(span).color)
}

test("picking a language colours the draft and sends it as the fence", async ({ page }) => {
  await openScratchpad(page)
  const editor = composerEditor(page)
  await editor.click()
  await page.keyboard.type("``` ")
  await page.keyboard.type("name: threa")

  const chip = editor.getByRole("button", { name: "Code language: Plain text" })
  await expect(chip).toBeVisible()
  const plainBox = await chip.boundingBox()
  await chip.click()

  const search = page.getByPlaceholder("Search languages")
  await expect(search).toBeFocused()
  await search.fill("yml")
  await page.keyboard.press("Enter")

  await expect(search).toBeHidden()
  await expect(editor.getByRole("button", { name: "Code language: YAML" })).toBeVisible()
  // github-light colours a YAML key #22863a.
  await expect.poll(() => tokenColor(editor, "name")).toBe("rgb(34, 134, 58)")

  // Focus is back in the code, so typing continues the block.
  await page.keyboard.type(" ok")
  await expect(editor.locator("pre code")).toHaveText("name: threa ok")

  const yamlBox = await editor.getByRole("button", { name: "Code language: YAML" }).boundingBox()
  expect({ x: yamlBox?.x, y: yamlBox?.y }).toEqual({ x: plainBox?.x, y: plainBox?.y })

  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
  const sent = page.getByRole("main").locator("[data-message-id] [data-wrap]").first()
  await expect(sent).toContainText("YAML", { timeout: 10_000 })
  await expect(sent).toContainText("name: threa ok")
})

test("Escape closes the picker and returns the caret to the code", async ({ page }) => {
  await openScratchpad(page)
  const editor = composerEditor(page)
  await editor.click()
  await page.keyboard.type("``` ")
  await page.keyboard.type("a")

  await editor.getByRole("button", { name: "Code language: Plain text" }).click()
  await expect(page.getByPlaceholder("Search languages")).toBeFocused()
  await page.keyboard.press("Escape")

  await expect(page.getByPlaceholder("Search languages")).toBeHidden()
  await page.keyboard.type("b")
  await expect(editor.locator("pre code")).toHaveText("ab")
})

test("reopening the list while it closes still focuses the search", async ({ page }) => {
  await openScratchpad(page)
  const editor = composerEditor(page)
  await editor.click()
  await page.keyboard.type("``` ")
  await page.keyboard.type("a")

  await editor.getByRole("button", { name: "Code language: Plain text" }).click()
  await page.getByPlaceholder("Search languages").fill("python")
  await page.keyboard.press("Enter")
  // No wait for the list to hide: the click lands during its exit animation.
  await editor.getByRole("button", { name: "Code language: Python" }).click()
  await expect(page.getByPlaceholder("Search languages")).toBeFocused()
})

test("a long line wraps, so the chip never scrolls out of view", async ({ page }) => {
  await openScratchpad(page)
  const editor = composerEditor(page)
  await editor.click()
  await page.keyboard.type("``` ")
  await page.keyboard.insertText(`const id = "${"0123456789abcdef".repeat(30)}"`)

  const scrollsSideways = await editor.locator("pre").evaluate((pre) => pre.scrollWidth > pre.clientWidth)
  expect(scrollsSideways).toBe(false)
  await expect(editor.getByRole("button", { name: "Code language: Plain text" })).toBeInViewport()
})

test("on a phone the chip opens the language drawer", async ({ page: setupPage, browser }) => {
  const url = await openScratchpad(setupPage)
  const context = await browser.newContext({
    storageState: await setupPage.context().storageState(),
    hasTouch: true,
    isMobile: true,
    viewport: PHONE,
  })
  const page = await context.newPage()
  await page.goto(url)
  // The phone composer's card takes the tap that focuses its editor.
  const card = page.locator("[data-composer-card]").last()
  await expect(card).toBeVisible({ timeout: 20_000 })
  const cardBox = (await card.boundingBox())!
  await page.touchscreen.tap(cardBox.x + cardBox.width / 2, cardBox.y + 18)
  const editor = page.locator("[data-editor-zone='main'] [contenteditable='true']").first()
  await expect(editor).toBeFocused()
  await page.keyboard.type("``` ")
  await page.keyboard.type("SELECT 1")

  const chip = editor.getByRole("button", { name: "Code language: Plain text" })
  const box = await chip.boundingBox()
  // The visible chip is small; its tap target is not.
  const hitHeight = await chip.evaluate((el) => parseFloat(getComputedStyle(el, "::after").height))
  expect(box!.height).toBeLessThan(24)
  expect(hitHeight).toBeGreaterThanOrEqual(40)
  await chip.tap()

  const drawer = page.locator("[data-vaul-drawer]")
  await expect(drawer).toBeVisible()
  await drawer.getByPlaceholder("Search languages").fill("sql")
  await drawer.getByRole("option", { name: "SQL" }).tap()

  await expect(drawer).toBeHidden({ timeout: 10_000 })
  await expect(editor.getByRole("button", { name: "Code language: SQL" })).toBeVisible()
  await context.close()
})

test("a language picked in a doc reaches the other tab and the saved markdown", async ({ page }) => {
  const { testId } = await loginAndCreateWorkspace(page, "doc-code-language")
  const workspaceId = workspaceIdFromUrl(page)
  const channelId = await createChannelViaApi(page, workspaceId, `code-docs-${testId}`, "private")
  const docId = await createDocViaApi(page, workspaceId, channelId)
  const second = await page.context().newPage()
  const [firstEditor, secondEditor] = [docEditor(page, docId), docEditor(second, docId)]
  for (const tab of [page, second]) {
    await openChannel(tab, workspaceId, channelId)
    await anchorRow(tab, docId).click()
  }
  await expect(firstEditor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 })
  await expect(secondEditor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 })

  await firstEditor.click()
  await page.keyboard.type("Intro")
  await page.keyboard.press("Enter")
  await page.keyboard.type("``` ")
  await page.keyboard.type("print(1)")
  await firstEditor.getByRole("button", { name: "Code language: Plain text" }).click()
  await page.getByPlaceholder("Search languages").fill("python")
  await page.keyboard.press("Enter")

  await expect(secondEditor.getByRole("button", { name: "Code language: Python" })).toBeVisible()

  // Clicking back into the text while the list is open leaves the caret where the click put it.
  await firstEditor.getByRole("button", { name: "Code language: Python" }).click()
  await expect(page.getByPlaceholder("Search languages")).toBeFocused()
  const intro = firstEditor.locator("p", { hasText: "Intro" })
  await intro.click()
  await expect(page.getByPlaceholder("Search languages")).toBeHidden()
  await page.keyboard.press("End")
  await page.keyboard.type(" first")
  await expect(intro).toHaveText("Intro first")
  await expect(firstEditor.locator("pre code")).toHaveText("print(1)")
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/workspaces/${workspaceId}/docs/${docId}`)
        if (!response.ok()) return ""
        const { sections } = (await response.json()) as { sections: { markdown: string }[] }
        return sections.map((section) => section.markdown).join("\n")
      },
      { timeout: 20_000 }
    )
    .toContain("```python\nprint(1)\n```")
})
