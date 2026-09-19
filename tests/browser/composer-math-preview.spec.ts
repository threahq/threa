import { test, expect, type Page, type Locator } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * The composer draws math as the message will render it, against the real
 * composer rather than a harness of the extension list.
 *
 * Both cases here shipped broken: an equation only drew once the caret left it,
 * so finishing one showed nothing, and the scan stopped at a paragraph, so
 * display math — which Enter splits across three of them — never drew at all.
 */

function composerEditor(page: Page): Locator {
  return page.getByRole("main").locator("[contenteditable='true']").first()
}

function previews(page: Page): Locator {
  return composerEditor(page).locator(".math-preview")
}

async function sendComposer(page: Page): Promise<void> {
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
}

function messageRows(page: Page): Locator {
  return page.getByRole("main").locator("[data-message-id]")
}

test.describe("Composer math preview", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "composer-math")
    const workspaceId = page.url().match(/\/w\/([^/]+)/)?.[1] ?? ""
    expect(workspaceId).not.toBe("")
    const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "scratchpad" },
    })
    await expectApiOk(response, "Create scratchpad")
    const { stream } = (await response.json()) as { stream: { id: string } }

    await page.goto(`/w/${workspaceId}/s/${stream.id}`)
    await expect(composerEditor(page)).toBeVisible({ timeout: 10000 })
    await composerEditor(page).click()
  })

  test("an inline equation draws the moment it is finished, and sends as what it drew", async ({ page }) => {
    await page.keyboard.type("Euler: $e^{i\\pi}+1=0$")

    // Nothing else happens here on purpose: the caret is still sitting right
    // after the closing `$`, which is where it is when you stop typing.
    await expect(previews(page)).toHaveCount(1)
    await expect(previews(page).locator(".katex")).toBeVisible()

    await sendComposer(page)
    const row = messageRows(page).filter({ hasText: "Euler:" }).first()
    // The message draws the same equation, not the `$…$` that produced it.
    // (`.katex-html` is the drawn one — KaTeX also emits the source TeX into a
    // MathML annotation, so asserting on the row's text proves nothing.)
    await expect(row.locator(".katex-html")).toBeVisible({ timeout: 10000 })
    await expect(row.locator("p").first()).toContainText("Euler:")
  })

  test("display math written across lines draws as one equation", async ({ page }) => {
    await page.keyboard.type("$$")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("\\frac{9}{31}")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("$$")

    await expect(previews(page)).toHaveCount(1)
    await expect(previews(page).locator(".katex-display")).toBeVisible()
    // All three lines of source collapse behind the equation they describe.
    await expect(composerEditor(page).locator(".math-source-block")).toHaveCount(3)

    // A tap gives the TeX back, which is the only way to edit it.
    await previews(page).click()
    await expect(previews(page)).toHaveCount(0)
    await expect(composerEditor(page)).toContainText("\\frac{9}{31}")

    await sendComposer(page)
    await expect(messageRows(page).locator(".katex-display")).toBeVisible({ timeout: 10000 })
  })
})
