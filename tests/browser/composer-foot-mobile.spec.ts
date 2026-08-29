import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

/**
 * The phone composer foot, folded: style · attach · aside | drafts · mic · send,
 * with marks, emoji, mention, the size toggle and schedule behind the Aa
 * popover. The contract this proves is focus: every tap in the foot and in the
 * popover leaves the caret in the editor, so the keyboard never drops.
 */

test.describe.configure({ timeout: 150_000 })

const PHONE = { width: 390, height: 780 }

async function seedMessages(page: Page, workspaceId: string, streamId: string, prefix: string): Promise<void> {
  for (let n = 1; n <= 4; n++) {
    const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: `${prefix} msg-${String(n).padStart(3, "0")}` },
    })
    expectApiOk(response, `Send message ${n}`)
  }
}

const activeIsEditor = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("contenteditable") === "true")

test.describe("Composer foot — phone", () => {
  // Real taps: the foot's focus contract keys off the active input being touch.
  test.use({ hasTouch: true })

  test("keeps the caret in the editor through the Aa popover, and opens an aside from the foot", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "composer-foot")
    // Touch contexts get the phone chrome, so the fixture channel is created
    // over the API rather than through the desktop sidebar.
    const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
    const created = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "channel", name: `foot-${testId}`, slug: `foot-${testId}`, visibility: "public" },
    })
    expectApiOk(created, "Create channel")
    const streamId = (await created.json()).stream.id as string
    await seedMessages(page, workspaceId, streamId, `[${testId}]`)
    await page.setViewportSize(PHONE)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.locator(`[data-stream-scroller="${streamId}"]`)).toBeVisible({ timeout: 20000 })

    const card = page.locator("[data-composer-card]").last()
    const box = await card.boundingBox()
    expect(box).not.toBeNull()
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + 18)
    const editor = page.locator("[data-editor-zone='main'] [contenteditable='true']").first()
    await expect(editor).toBeFocused()

    // Six controls at rest; emoji, mention, the size toggle and schedule are folded.
    const foot = page.locator("[data-message-composer-root]")
    for (const name of ["Formatting", "Attach files", "Open an aside", /^Drafts/, /^Send$/]) {
      await expect(foot.getByRole("button", { name })).toBeVisible()
    }
    for (const name of ["Insert emoji", "Insert mention", "Expand editor", /^Scheduled/]) {
      await expect(foot.getByRole("button", { name })).toHaveCount(0)
    }

    // Aa: the popover opens over the card and the caret stays put.
    await foot.getByRole("button", { name: "Formatting" }).tap()
    const popover = page.getByTestId("composer-format-popover")
    await expect(popover).toBeVisible()
    expect(await activeIsEditor(page)).toBe(true)

    // A mark from the popover applies to what is typed next; the popover stays
    // (marks come in bunches) and so does the caret.
    await popover.getByRole("button", { name: "Bold" }).tap()
    await page.keyboard.type("bold")
    await expect(editor.locator("strong")).toHaveText("bold")
    await expect(popover).toBeVisible()
    expect(await activeIsEditor(page)).toBe(true)

    // A row hands over to its own surface and closes the popover: Emoji opens
    // the emoji picker inline, still without moving focus.
    await popover.getByRole("button", { name: "Emoji" }).tap()
    await expect(popover).toHaveCount(0)
    await expect(page.locator("[aria-label='Emoji picker']")).toBeVisible({ timeout: 5000 })
    expect(await activeIsEditor(page)).toBe(true)
    await page.keyboard.press("Backspace")

    // Schedule row: the scheduled-messages picker opens from the foot's hidden slot.
    await foot.getByRole("button", { name: "Formatting" }).tap()
    await popover.getByRole("button", { name: "Schedule" }).tap()
    await expect(popover).toHaveCount(0)
    const schedule = page.getByRole("dialog").last()
    await expect(schedule).toBeVisible()
    expect(await activeIsEditor(page)).toBe(true)
    await page.keyboard.press("Escape")
    await expect(schedule).toHaveCount(0)

    // The aside button: one tap, and the typing goes with it into the aside.
    await foot.getByRole("button", { name: "Open an aside" }).tap()
    const sheet = page.getByTestId("aside-sheet")
    await expect(sheet).toBeVisible({ timeout: 15000 })
    const asideEditor = sheet.getByTestId("aside-conversation").locator("[contenteditable='true']")
    await expect(asideEditor).toBeFocused({ timeout: 10000 })
    await expect(sheet).toHaveAttribute("data-detent", "full")
    // The aside's own foot carries no aside button (no aside on an aside).
    await expect(sheet.getByRole("button", { name: "Open an aside" })).toHaveCount(0)
  })
})
