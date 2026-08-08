import { test, expect, type Page } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * User-journey e2e for board⇄timeline draft sharing (the 2026-08-06 staging
 * rework). Each test is a naive user's flow, asserted at the surface — no
 * implementation reach-ins beyond what a user can see.
 *
 * 1. A half-typed timeline reply is pick-up-able from the conversation's card
 *    on the board, and continuing there works.
 * 2. Stashing on the board STICKS: the resting button stops advertising, the
 *    reopened composer is empty, and the pile still offers the row.
 * 3. Sending a fast-typed message never leaves a stray draft behind.
 */

function workspaceIdFrom(page: Page): string {
  const match = page.url().match(/\/w\/(ws_[a-z0-9]+)/i)
  if (!match) throw new Error(`No workspace id in url ${page.url()}`)
  return match[1]
}

async function typeInto(page: Page, editor: ReturnType<Page["locator"]>, text: string) {
  await editor.click()
  await expect(editor).toBeFocused()
  await editor.pressSequentially(text, { delay: 3 })
  await expect(editor).toContainText(text)
}

test.describe("draft sharing across surfaces", () => {
  let workspaceId: string

  test.beforeEach(async ({ page }) => {
    test.setTimeout(240_000)
    await loginAndCreateWorkspace(page, "draft-journey")
    workspaceId = workspaceIdFrom(page)
    await createChannel(page, "product-chat", { switchToAll: false })
    const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.click()
    await composer.pressSequentially("Should we ship the new onboarding this week?", { delay: 3 })
    await page.keyboard.press("Enter")
    await page.waitForTimeout(700)
  })

  test("a half-typed timeline reply is picked up from the board and continues there", async ({ page }) => {
    const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
    await typeInto(page, composer, "I think we should wait until the")
    await page.waitForTimeout(900) // debounce persists it

    await page.goto(`/w/${workspaceId}/board?lens=all`)
    await page
      .getByRole("button", { name: /write a reply/i })
      .first()
      .click()
    const boardComposer = page.locator("[contenteditable='true']").last()
    await expect(boardComposer).toBeFocused({ timeout: 10_000 })

    // The pile offers the timeline draft as "From elsewhere"; picking it lands
    // the content here with no error toast (take-over, never a refusal).
    await page
      .getByRole("button", { name: /drafts/i })
      .last()
      .click()
    await expect(page.getByText(/from elsewhere/i)).toBeVisible({ timeout: 10_000 })
    await page.getByText("I think we should wait until the").click()
    await expect(page.locator("[data-sonner-toast][data-type='error']")).toHaveCount(0)
    await expect(page.locator("[contenteditable='true']").last()).toContainText("I think we should wait until the", {
      timeout: 10_000,
    })

    // Continuing the thought works in place.
    const continued = page.locator("[contenteditable='true']").last()
    await continued.click()
    await page.keyboard.press("End")
    await continued.pressSequentially(" metrics settle.", { delay: 3 })
    await expect(continued).toContainText("I think we should wait until the metrics settle.")
  })

  test("stashing on the board sticks — no re-advertise, no auto-restore, still in the pile", async ({ page }) => {
    await page.goto(`/w/${workspaceId}/board?lens=all`)
    await page
      .getByRole("button", { name: /write a reply/i })
      .first()
      .click()
    const boardComposer = page.locator("[contenteditable='true']").last()
    await expect(boardComposer).toBeFocused({ timeout: 10_000 })
    await boardComposer.pressSequentially("board reply to put away", { delay: 3 })
    await expect(boardComposer).toContainText("board reply to put away")
    await page.waitForTimeout(900)

    // Prove the preview has hydrated and advertises the live draft before
    // testing its transition to absent after stashing.
    await page.goto(`/w/${workspaceId}/board?lens=all`)
    const persistedPreview = page.getByText("board reply to put away").first()
    await expect(persistedPreview).toBeVisible({ timeout: 15_000 })
    await persistedPreview.click()
    await expect(page.locator("[contenteditable='true']").last()).toContainText("board reply to put away")

    await page
      .getByRole("button", { name: /drafts/i })
      .last()
      .click()
    await page.getByRole("button", { name: /save current/i }).click()
    await page.waitForTimeout(600)

    // Fresh board visit: the resting button must not advertise the put-away
    // draft, and opening the composer must not auto-restore it.
    await page.goto(`/w/${workspaceId}/board?lens=all`)
    const resting = page.getByRole("button", { name: /write a reply/i }).first()
    await expect(resting).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/continue reply/i)).toHaveCount(0)
    await resting.click()
    await page.waitForTimeout(800)
    await expect(page.locator("[contenteditable='true']").last()).not.toContainText("board reply to put away")

    // The pile still offers it — put away, not lost.
    await page
      .getByRole("button", { name: /drafts/i })
      .last()
      .click()
    await expect(page.getByText("board reply to put away")).toBeVisible({ timeout: 10_000 })
  })

  test("sending a fast-typed message leaves no stray draft", async ({ page }) => {
    // The beforeEach already sent one fast-typed message; send two more with a
    // mid-typing pause (the shape that used to fork a prefix row).
    const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
    for (const text of ["Second message, typed quickly enough.", "Third message to be extra sure."]) {
      await composer.click()
      await composer.pressSequentially(text.slice(0, 6), { delay: 3 })
      await page.waitForTimeout(560) // let a mid-typing debounce fire
      if (text.startsWith("Second")) {
        // Observe the positive state before the final no-draft assertion: the
        // debounce-created row must make the sidebar affordance active first.
        await expect(page.locator('a[href*="/drafts"]')).not.toHaveClass(/text-muted-foreground/)
      }
      await composer.pressSequentially(text.slice(6), { delay: 2 })
      await page.keyboard.press("Enter")
      await page.waitForTimeout(900)
    }
    // The user-visible signal: the sidebar Drafts link stays greyed (no drafts).
    await expect(page.locator('a[href*="/drafts"]')).toHaveClass(/text-muted-foreground/, { timeout: 10_000 })
  })
})
