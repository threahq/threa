import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, generateTestId } from "./helpers"

/**
 * Conversation overlay E2E: toggle the overlay in a channel, see messages
 * grouped by conversation (legend + topic chips + colored rails), focus a
 * conversation from the legend, and correct a message's conversation via the
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

test("conversation overlay shows groups, focuses, and applies corrections", async ({ page }) => {
  test.setTimeout(120000)

  const testId = generateTestId()
  await loginAndCreateWorkspace(page, "convoverlay")
  const channelName = `overlay-${testId}`
  await createChannel(page, channelName)

  const topicA = `Planera varens offsite ${testId}`
  const topicB = `Buggen i inloggningen ${testId}`
  await sendChannelMessage(page, `${topicA}. Vi behover boka lokal snart.`)
  await sendChannelMessage(page, `${topicB}. Safari-anvandare kommer inte in.`)

  // Toggle the overlay from the stream header. State is URL-derived.
  await page.getByRole("button", { name: "Conversation overlay" }).click()
  await expect(page).toHaveURL(/convOverlay=on/)

  // Legend appears and fills with one chip per conversation as the stub
  // extractor's assignments arrive (live via conversation:created events),
  // and each conversation gets a block-start chip in the timeline.
  const legend = page.getByTestId("conversation-legend")
  const legendChipA = legend.getByRole("button", { name: new RegExp(topicA) })
  const blockChips = page.getByTestId("conversation-block-chip")
  await expect(legendChipA).toBeVisible({ timeout: 30000 })
  await expect(legend.getByRole("button", { name: new RegExp(topicB) })).toBeVisible({ timeout: 30000 })
  await expect(blockChips.filter({ hasText: topicA })).toHaveCount(1, { timeout: 30000 })
  await expect(blockChips.filter({ hasText: topicB })).toHaveCount(1, { timeout: 30000 })

  await page.screenshot({ path: test.info().outputPath("overlay-on.png") })

  // Overlay survives a reload (INV-59: view state lives in the URL).
  await page.reload()
  await expect(legendChipA).toBeVisible({ timeout: 30000 })

  // Focus conversation A from the legend: chip reports pressed state and
  // message rows of other conversations dim.
  await legendChipA.click()
  await expect(legendChipA).toHaveAttribute("aria-pressed", "true")
  const dimmedRowB = page.locator("[data-editor-zone='main'] .opacity-40").filter({ hasText: topicB })
  await expect(dimmedRowB.first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("overlay-focused.png") })
  // Unfocus.
  await legendChipA.click()
  await expect(legendChipA).toHaveAttribute("aria-pressed", "false")

  // Correct message B into conversation A via the rail swatch menu.
  const rowB = page.getByTestId("conversation-overlay-row").filter({ hasText: topicB })
  await rowB.getByRole("button", { name: "Correct conversation for this message" }).click()
  await page.screenshot({ path: test.info().outputPath("overlay-menu.png") })
  await page.getByRole("menuitem", { name: new RegExp(topicA) }).click()

  // Message B now belongs to conversation A: its block-start chip for topic B
  // disappears from the timeline, and conversation A's legend chip counts 2.
  await expect(blockChips.filter({ hasText: topicB })).toHaveCount(0, { timeout: 15000 })
  await expect(legend.getByRole("button", { name: new RegExp(`${topicA} 2`) })).toBeVisible({ timeout: 15000 })
  await page.screenshot({ path: test.info().outputPath("overlay-reassigned.png") })

  // Close from the legend: overlay decorations and URL param drop.
  await page.getByRole("button", { name: "Hide conversation overlay" }).click()
  await expect(page).not.toHaveURL(/convOverlay/)
  await expect(legend).toHaveCount(0)
  await expect(blockChips).toHaveCount(0)
})
