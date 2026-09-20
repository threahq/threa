import { test, expect, type Page, type Locator } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * Math in the composer is a node, so the Σ button opens an edit block the way
 * the code-block button opens one — it never writes `$` into the message.
 *
 * Driven through the real toolbar and the real composer: the decoration version
 * of this feature passed a harness of the extension list and failed on first
 * use.
 */

function composerEditor(page: Page): Locator {
  return page.getByRole("main").locator("[contenteditable='true']").first()
}

function equations(page: Page): Locator {
  return composerEditor(page).locator(".math-node")
}

function texField(page: Page): Locator {
  return composerEditor(page).locator(".math-field")
}

/** The Math button collapses behind the formatting toggle on a narrow composer. */
async function clickMathButton(page: Page): Promise<void> {
  const math = page.getByRole("main").getByRole("button", { name: "Math", exact: true })
  if (!(await math.isVisible())) {
    await page.getByRole("main").getByRole("button", { name: "Formatting", exact: true }).click()
  }
  await math.click()
}

async function sendComposer(page: Page): Promise<void> {
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
}

function messageRows(page: Page): Locator {
  return page.getByRole("main").locator("[data-message-id]")
}

test.describe("Composer math", () => {
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

  test("the Math button opens an edit block, and the message sends what it drew", async ({ page }) => {
    await page.keyboard.type("Euler: ")
    await clickMathButton(page)

    // The button's whole job: a field with the caret in it, not delimiters in
    // the message.
    await expect(texField(page)).toBeFocused()
    await expect(composerEditor(page)).not.toContainText("$")

    await page.keyboard.type("e^{i\\pi}+1=0")
    await page.keyboard.press("Enter")

    // Enter finishes the equation rather than sending the message.
    await expect(texField(page)).toHaveCount(0)
    await expect(equations(page).locator(".katex")).toBeVisible()
    await expect(messageRows(page)).toHaveCount(0)

    // And the caret is after the equation, so typing continues the sentence.
    await page.keyboard.type(" holds")
    await sendComposer(page)

    const row = messageRows(page).filter({ hasText: "Euler:" }).first()
    await expect(row.locator(".katex-html")).toBeVisible({ timeout: 10000 })
    await expect(row.locator("p").first()).toContainText("holds")
    await expect(row.locator("p").first()).not.toContainText("$")
  })

  test("tapping an equation opens its TeX again", async ({ page }) => {
    await clickMathButton(page)
    await page.keyboard.type("x^2")
    await page.keyboard.press("Enter")
    await expect(equations(page).locator(".katex")).toBeVisible()

    await equations(page).locator(".math-drawn").click()

    await expect(texField(page)).toBeFocused()
    await expect(texField(page)).toHaveValue("x^2")
  })

  // Shift+Enter is the key that carries the block triggers in both send modes —
  // ``` opens a code block on it for the same reason.
  test("`$$` and Shift+Enter opens a display equation", async ({ page }) => {
    await page.keyboard.type("$$")
    await page.keyboard.press("Shift+Enter")

    await expect(texField(page)).toBeFocused()
    await page.keyboard.type("\\frac{9}{31}")
    // A display equation takes lines, so it finishes on the empty one — the
    // rule a code block already uses here.
    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")

    await expect(equations(page).locator(".katex-display")).toBeVisible()

    await sendComposer(page)
    await expect(messageRows(page).locator(".katex-display")).toBeVisible({ timeout: 10000 })
  })

  test("the caret arrows into an equation and back out the other side", async ({ page }) => {
    await page.keyboard.type("a ")
    await clickMathButton(page)
    await page.keyboard.type("x^2")
    await page.keyboard.press("Enter")
    await page.keyboard.type(" b")
    await expect(texField(page)).toHaveCount(0)

    // Back across " b", then onto the equation.
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await expect(texField(page)).toBeFocused()
    await expect(texField(page)).toHaveValue("x^2")

    // Off the far end the caret leaves the equation intact rather than being
    // stuck in it — and the equation is still one node, not `$` characters.
    await page.keyboard.press("ArrowRight")
    await expect(texField(page)).toHaveCount(0)
    await expect(equations(page)).toHaveCount(1)
    await expect(composerEditor(page)).not.toContainText("$")
  })

  test("the toggle makes an equation a block, and then Enter adds lines to it", async ({ page }) => {
    await clickMathButton(page)
    await page.keyboard.type("a=1")
    // The phone path to a display equation: its keyboard has no Shift.
    // The toggle lives in the preview popover, which portals out of the composer.
    await page.getByRole("button", { name: "Make this a display equation" }).click()
    await expect(texField(page)).toBeFocused()

    await page.keyboard.press("Enter")
    await page.keyboard.type("b=2")
    await expect(texField(page)).toHaveValue("a=1\nb=2")

    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await expect(texField(page)).toHaveCount(0)
    await expect(equations(page).locator(".katex-display")).toBeVisible()

    await sendComposer(page)
    await expect(messageRows(page).locator(".katex-display")).toBeVisible({ timeout: 10000 })
  })
})
