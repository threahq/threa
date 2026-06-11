import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, generateTestId } from "./helpers"

/**
 * Conversation overlay E2E: toggle the overlay in a channel without shifting
 * the timeline layout (decoration is rails/washes + a floating top-right
 * panel of in-view conversations), focus a conversation from the panel,
 * collapse/expand the panel, and correct a message's conversation via the
 * rail swatch menu (which must recolor live through the reassign endpoint +
 * socket events).
 *
 * The stub boundary extractor assigns every channel message its own new
 * conversation, so N messages → N conversations with the message's first
 * sentence as topic.
 */

async function sendChannelMessage(page: Page, text: string): Promise<void> {
  const editor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
  await editor.click()
  await page.keyboard.type(text)
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.locator("[data-editor-zone='main']").getByText(text)).toBeVisible({ timeout: 10000 })
}

test("conversation overlay shows in-view groups without layout shift and applies corrections", async ({ page }) => {
  test.setTimeout(120000)

  const testId = generateTestId()
  await loginAndCreateWorkspace(page, "convoverlay")
  const channelName = `overlay-${testId}`
  await createChannel(page, channelName)

  const topicA = `Planera varens offsite ${testId}`
  const topicB = `Buggen i inloggningen ${testId}`
  await sendChannelMessage(page, `${topicA}. Vi behover boka lokal snart.`)
  await sendChannelMessage(page, `${topicB}. Safari-anvandare kommer inte in.`)

  const rowA = page.locator("div[data-event-id][data-message-id]").filter({ hasText: topicA })

  // Toggle the overlay from the stream header. State is URL-derived.
  await page.getByRole("button", { name: "Conversation overlay", exact: true }).click()
  await expect(page).toHaveURL(/convOverlay=on/)

  // The floating panel fills with the conversations whose rows are on screen
  // (live via conversation:created events + IntersectionObserver tracking).
  const panel = page.getByTestId("conversation-overlay-panel")
  const panelRowA = panel.getByRole("button", { name: new RegExp(topicA) })
  const panelRowB = panel.getByRole("button", { name: new RegExp(topicB) })
  await expect(panelRowA).toBeVisible({ timeout: 30000 })
  await expect(panelRowB).toBeVisible({ timeout: 30000 })

  // Each conversation block gets a floating topic chip on its first message.
  const blockChips = page.getByTestId("conversation-block-chip")
  await expect(blockChips.filter({ hasText: topicA })).toHaveCount(1)
  await expect(blockChips.filter({ hasText: topicB })).toHaveCount(1)

  // The decoration must not reflow the timeline. Measured by toggling the
  // overlay off and back on NOW, when the timeline is quiescent (extraction
  // done, panel filled) — comparing across the initial toggle instead would
  // race the live settling of freshly sent messages, which moves rows for
  // reasons unrelated to the overlay.
  const yWithOverlay = (await rowA.boundingBox())!.y
  await page.getByRole("button", { name: "Conversation overlay", exact: true }).click()
  await expect(panel).toHaveCount(0)
  const yWithoutOverlay = (await rowA.boundingBox())!.y
  expect(Math.abs(yWithOverlay - yWithoutOverlay)).toBeLessThan(0.5)
  await page.getByRole("button", { name: "Conversation overlay", exact: true }).click()
  await expect(panelRowA).toBeVisible({ timeout: 15000 })

  await page.screenshot({ path: test.info().outputPath("overlay-on.png") })

  // Overlay survives a reload (INV-59: view state lives in the URL).
  await page.reload()
  await expect(panelRowA).toBeVisible({ timeout: 30000 })

  // Panel collapses to a compact pill and expands back.
  await panel.getByRole("button", { name: "Collapse conversations panel" }).click()
  const expandPill = panel.getByRole("button", { name: "Show conversations in view" })
  await expect(expandPill).toBeVisible()
  await expect(panelRowA).toHaveCount(0)
  await expandPill.click()
  await expect(panelRowA).toBeVisible()

  // Focus conversation A from the panel: row reports pressed state and
  // message rows of other conversations dim.
  await panelRowA.click()
  await expect(panelRowA).toHaveAttribute("aria-pressed", "true")
  const dimmedRowB = page.locator("[data-editor-zone='main'] .opacity-40").filter({ hasText: topicB })
  await expect(dimmedRowB.first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("overlay-focused.png") })
  // Unfocus.
  await panelRowA.click()
  await expect(panelRowA).toHaveAttribute("aria-pressed", "false")

  // Correct message B into conversation A via the rail swatch menu.
  const overlayRowB = page.getByTestId("conversation-overlay-row").filter({ hasText: topicB })
  await overlayRowB.getByRole("button", { name: "Correct conversation for this message" }).click()
  await page.screenshot({ path: test.info().outputPath("overlay-menu.png") })
  await page.getByRole("menuitem", { name: new RegExp(topicA) }).click()

  // Message B now belongs to conversation A: conversation A's panel row
  // counts 2, conversation B (no rows left on screen) drops from the
  // in-view panel, and B's floating chip leaves the timeline.
  await expect(panel.getByRole("button", { name: new RegExp(`${topicA} 2`) })).toBeVisible({ timeout: 15000 })
  await expect(panelRowB).toHaveCount(0, { timeout: 15000 })
  await expect(blockChips.filter({ hasText: topicB })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("overlay-reassigned.png") })

  // Correct it back through the message action menu's "Move to conversation…"
  // entry — the same action list the mobile long-press drawer renders, so
  // this covers the touch path's plumbing (action visibility + picker sheet).
  // Hover→click is retried: the toolbar is hover-revealed and can race
  // layout in CI (same pattern as editor-auto-focus.spec.ts).
  const moveOption = page.getByRole("menuitem", { name: "Move to conversation…" })
  for (let attempt = 0; attempt < 3; attempt++) {
    await overlayRowB.locator(".message-item").hover()
    await overlayRowB.getByRole("button", { name: "Message actions" }).click()
    try {
      await expect(moveOption).toBeVisible({ timeout: 3000 })
      break
    } catch {
      if (attempt === 2) throw new Error("Failed to open message actions menu after 3 attempts")
      await page.keyboard.press("Escape").catch(() => {})
    }
  }
  await moveOption.click()
  const picker = page.getByRole("dialog").filter({ hasText: "This message belongs to" })
  await expect(picker).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("overlay-picker.png") })
  await picker.getByRole("button", { name: new RegExp(topicB) }).click()

  // Conversation B regains the message: back in the in-view panel with its
  // chip in the timeline, and conversation A's count drops back to 1.
  await expect(panelRowB).toBeVisible({ timeout: 15000 })
  await expect(blockChips.filter({ hasText: topicB })).toHaveCount(1)
  await expect(panel.getByRole("button", { name: new RegExp(`${topicA} 1`) })).toBeVisible({ timeout: 15000 })

  // Close from the panel: overlay decorations and URL param drop.
  await panel.getByRole("button", { name: "Hide conversation overlay" }).click()
  await expect(page).not.toHaveURL(/convOverlay/)
  await expect(panel).toHaveCount(0)
})
