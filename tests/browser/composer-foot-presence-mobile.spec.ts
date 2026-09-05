import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

/**
 * The phone foot hides the drafts and scheduled pickers (they stay mounted as
 * slot nodes so their popovers and the composer bridge survive), which also
 * hides the presence dots they wear on desktop. This proves the "+" carries
 * that presence instead: a dot on the trigger, the counts on its rows.
 */

test.describe.configure({ timeout: 150_000 })

const PHONE = { width: 390, height: 780 }

test.describe("Composer foot presence — phone", () => {
  test.use({ hasTouch: true })

  test("the + names and counts the drafts and scheduled sends waiting behind it", async ({ page }, testInfo) => {
    const { testId } = await loginAndCreateWorkspace(page, "foot-presence")
    const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
    const created = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "channel", name: `presence-${testId}`, slug: `presence-${testId}`, visibility: "public" },
    })
    await expectApiOk(created, "Create channel")
    const streamId = (await created.json()).stream.id as string

    for (let n = 1; n <= 4; n++) {
      const sent = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: `[${testId}] msg-${n}` },
      })
      await expectApiOk(sent, `Send message ${n}`)
    }

    const scheduled = await page.request.post(`/api/workspaces/${workspaceId}/scheduled`, {
      data: {
        streamId,
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ship it" }] }] },
        scheduledFor: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    })
    await expectApiOk(scheduled, "Schedule message")

    await page.setViewportSize(PHONE)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.locator(`[data-stream-scroller="${streamId}"]`)).toBeVisible({ timeout: 20000 })

    const card = page.locator("[data-composer-card]").last()
    const editor = page.locator("[data-editor-zone='main'] [contenteditable='true']").first()
    // A real tap on the card: the composer's expanded chrome (the one holding
    // the "+") is a focus state, and the card's own padding intercepts clicks
    // aimed at the editor box.
    const focusComposer = async () => {
      const box = await card.boundingBox()
      await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + 18)
      await expect(editor).toBeFocused()
    }
    await focusComposer()

    const foot = page.locator("[data-message-composer-root]")
    const more = foot.getByRole("button", { name: /^More/ })
    // The scheduled send alone already marks the "+" — the picker's count
    // travels up through the composer bridge even though its trigger is hidden.
    await expect(more).toHaveAccessibleName("More (1 scheduled)")

    // Two stashes through the menu itself: type, open "+", tap Drafts, then
    // "Save current" — the pile grows by one and the composer clears.
    const rounds: Array<[string, string]> = [
      ["first stashed body", "More (1 saved draft, 1 scheduled)"],
      ["second stashed body", "More (2 saved drafts, 1 scheduled)"],
    ]
    for (const [body, name] of rounds) {
      await page.keyboard.type(body)
      await more.tap()
      await page.getByRole("button", { name: /^Drafts/ }).tap()
      await page.getByRole("button", { name: "Save current" }).tap()
      await expect(editor).toHaveText("", { timeout: 10000 })
      // The picker's dismiss returns focus to the composer; an unfocused foot
      // collapses to "Type a message…" and has no "+" to read.
      await page.keyboard.press("Escape")
      await focusComposer()
      await expect(more).toHaveAccessibleName(name)
    }

    await testInfo.attach("foot-plus-dot", { body: await card.screenshot(), contentType: "image/png" })

    await more.tap()
    const drafts = page.getByRole("button", { name: /^Drafts/ })
    const schedule = page.getByRole("button", { name: /^Schedule/ })
    await expect(drafts).toHaveAccessibleName("Drafts (2 saved)")
    await expect(schedule).toHaveAccessibleName("Schedule (1 pending)")
    await testInfo.attach("foot-plus-menu", { body: await page.screenshot(), contentType: "image/png" })
  })
})
