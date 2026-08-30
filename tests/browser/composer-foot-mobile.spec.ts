import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

/**
 * The phone composer foot: Aa · + | mic · send, with attach, aside, schedule,
 * drafts and the size toggle behind +. Aa holds the selection (the native
 * selection collapses, which is what dismisses the OS text toolbar) and swaps
 * the row for the marks. The contract this proves is focus: every tap leaves
 * the caret in the editor, so the keyboard never drops, and the marks land on
 * the held range.
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

const nativeSelection = (page: Page) =>
  page.evaluate(() => {
    const sel = document.getSelection()
    return { collapsed: sel?.isCollapsed ?? true, text: sel?.toString() ?? "" }
  })

test.describe("Composer foot — phone", () => {
  // Real taps: the foot's focus contract keys off the active input being touch.
  test.use({ hasTouch: true })

  test("holds the selection behind Aa, keeps the caret through the + menu, and opens an aside from it", async ({
    page,
  }) => {
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

    // Four controls at rest; everything else is behind +.
    const foot = page.locator("[data-message-composer-root]")
    for (const name of ["Formatting", "More", /^Send$/]) {
      await expect(foot.getByRole("button", { name })).toBeVisible()
    }
    for (const name of [
      "Insert emoji",
      "Insert mention",
      "Expand editor",
      "Attach files",
      "Open an aside",
      /^Drafts/,
    ]) {
      await expect(foot.getByRole("button", { name })).toHaveCount(0)
    }

    // Select a word, then Aa: the native selection collapses (the OS toolbar
    // goes with it), the word stays held and painted, the caret stays put, and
    // the foot row is now the marks.
    await page.keyboard.type("hold me")
    await page.keyboard.press("Shift+Home")
    expect(await nativeSelection(page)).toEqual({ collapsed: false, text: "hold me" })
    const restBox = (await card.boundingBox())!
    const aaBox = (await foot.getByRole("button", { name: "Formatting" }).boundingBox())!
    await foot.getByRole("button", { name: "Formatting" }).tap()
    await expect(foot.getByRole("button", { name: "Bold" })).toBeVisible()
    await expect(foot.getByRole("button", { name: "More" })).toHaveCount(0)
    // The marks row is the same height as the foot, and Aa stays where it was:
    // nothing above it moves when it opens.
    expect((await card.boundingBox())!.height).toBe(restBox.height)
    expect((await card.boundingBox())!.y).toBe(restBox.y)
    expect((await foot.getByRole("button", { name: "Formatting" }).boundingBox())!.x).toBe(aaBox.x)
    expect(await nativeSelection(page)).toEqual({ collapsed: true, text: "" })
    await expect(editor.locator(".held-selection")).toHaveText("hold me")
    expect(await activeIsEditor(page)).toBe(true)

    // A mark lands on the held range, not at the caret; the row stays (marks
    // come in bunches), the hold stays, and so does the caret.
    await foot.getByRole("button", { name: "Bold" }).tap()
    await expect(editor.locator("strong")).toHaveText("hold me")
    await expect(foot.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true")
    expect(await nativeSelection(page)).toEqual({ collapsed: true, text: "" })
    await expect(editor.locator(".held-selection")).toHaveText("hold me")
    expect(await activeIsEditor(page)).toBe(true)

    // The link editor's URL input is the one thing that must take focus; Enter
    // applies to the held range and hands the caret back, still collapsed.
    await foot.getByRole("button", { name: "Link" }).tap()
    const url = foot.getByPlaceholder("https://example.com")
    await expect(url).toBeFocused()
    await page.keyboard.type("https://threa.dev")
    await page.keyboard.press("Enter")
    await expect(editor.locator("a[href='https://threa.dev']")).toHaveText("hold me")
    expect(await activeIsEditor(page)).toBe(true)
    expect(await nativeSelection(page)).toEqual({ collapsed: true, text: "" })

    // Selecting text again while the row is open takes over from the hold: the
    // paint goes and the live selection is the target. Aa re-holds it (the row
    // stays) instead of closing.
    await page.keyboard.press("Shift+Home")
    await expect(editor.locator(".held-selection")).toHaveCount(0)
    expect(await nativeSelection(page)).toEqual({ collapsed: false, text: "hold me" })
    await foot.getByRole("button", { name: "Formatting" }).tap()
    await expect(editor.locator(".held-selection")).toHaveText("hold me")
    await expect(foot.getByRole("button", { name: "Bold" })).toBeVisible()
    expect(await nativeSelection(page)).toEqual({ collapsed: true, text: "" })

    // Aa again hands the word back as the real selection (the OS toolbar may
    // return; that's the user's selection again), and the row folds back.
    await foot.getByRole("button", { name: "Formatting" }).tap()
    await expect(foot.getByRole("button", { name: "More" })).toBeVisible()
    await expect(editor.locator(".held-selection")).toHaveCount(0)
    expect(await nativeSelection(page)).toEqual({ collapsed: false, text: "hold me" })
    await page.keyboard.press("End")
    await page.keyboard.type(" on")
    await expect(editor).toHaveText("hold me on")
    expect(await activeIsEditor(page)).toBe(true)

    // + rows hand over to their own surface and close the menu: Schedule opens
    // the scheduled-messages picker from the foot's hidden slot.
    await foot.getByRole("button", { name: "More" }).tap()
    const menu = page.getByTestId("composer-foot-menu")
    await expect(menu).toBeVisible()
    expect(await activeIsEditor(page)).toBe(true)
    await menu.getByRole("button", { name: "Schedule" }).tap()
    await expect(menu).toHaveCount(0)
    const schedule = page.getByRole("dialog").last()
    await expect(schedule).toBeVisible()
    expect(await activeIsEditor(page)).toBe(true)
    await page.keyboard.press("Escape")
    await expect(schedule).toHaveCount(0)

    // The aside row: the typing goes with it into the aside.
    await foot.getByRole("button", { name: "More" }).tap()
    await menu.getByRole("button", { name: "Open an aside" }).tap()
    const sheet = page.getByTestId("aside-sheet")
    await expect(sheet).toBeVisible({ timeout: 15000 })
    const asideEditor = sheet.getByTestId("aside-conversation").locator("[contenteditable='true']")
    await expect(asideEditor).toBeFocused({ timeout: 10000 })
    await expect(sheet).toHaveAttribute("data-detent", "full")
    // The aside's own foot carries no aside row (no aside on an aside).
    await sheet.getByRole("button", { name: "More" }).tap()
    await expect(page.getByTestId("composer-foot-menu").getByRole("button", { name: "Open an aside" })).toHaveCount(0)
    await page.keyboard.press("Escape")

    const chip = page.getByTestId("aside-header-chip")
    await expect(chip).toHaveAttribute("data-attention", "open")
    const asideId = await sheet.getByTestId("aside-pane").getAttribute("data-aside-id")
    expect(asideId).toBeTruthy()
    await sheet.getByRole("button", { name: "Close aside" }).tap()
    await expect(sheet).toHaveCount(0)
    await expect(chip).toHaveAttribute("data-attention", "quiet")
    await chip.tap()
    await expect(sheet).toBeVisible({ timeout: 10000 })
    await expect(chip).toHaveAttribute("data-attention", "open")
    // Resumed, not replaced: the same aside comes back.
    await expect(sheet.getByTestId("aside-pane")).toHaveAttribute("data-aside-id", asideId!)
  })
})
