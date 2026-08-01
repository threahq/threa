import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * Cycling through in-stream search results across jump windows — the part no
 * component test reaches: each navigation swaps the timeline's event window
 * via /events/around, and the regression this guards only appears once a
 * previous jump's window is live and the next target sits near the live tail
 * (hasNewer=false). jumpToEvent used to early-return without exiting jump
 * mode there, leaving the timeline frozen on the old window while the match
 * counter kept advancing.
 */

test.describe.configure({ timeout: 600_000 })

/** The gap between the two matches must exceed a jump window (25 each side)
 *  plus two newer-pagination pages (50 each) — the scroll-edge recheck after a
 *  window swap can append newer pages and silently heal a smaller gap, which
 *  would let the frozen-window regression pass unexercised. The tail match
 *  sits inside the last ~25 events so its /events/around answers
 *  hasNewer=false. */
const TOTAL = 175
const MATCH_POSITIONS = [30, 165]

async function seedMessages(page: Page, workspaceId: string, streamId: string): Promise<void> {
  const BATCH_SIZE = 10
  const send = async (i: number) => {
    const matchIndex = MATCH_POSITIONS.indexOf(i)
    const content =
      matchIndex >= 0
        ? `Note ${i}: the pelican lands here (match ${matchIndex + 1} of ${MATCH_POSITIONS.length}).`
        : `Filler ${i}: routine update about nothing in particular.`
    // TOTAL exceeds the 120/min message-create rate limit — wait out 429s.
    // The workspace-router worker occasionally restarts mid-request (503);
    // retry those too.
    for (let attempt = 0; ; attempt++) {
      const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content },
      })
      if (response.ok()) return
      if ((response.status() === 429 || response.status() >= 500) && attempt < 30) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        continue
      }
      await expectApiOk(response, `Send message ${i}`)
    }
  }
  for (let start = 1; start <= TOTAL; start += BATCH_SIZE) {
    const batch: Promise<void>[] = []
    for (let i = start; i <= Math.min(start + BATCH_SIZE - 1, TOTAL); i++) batch.push(send(i))
    await Promise.all(batch)
  }
}

test("cycles through matches in both directions across jump windows", async ({ page }) => {
  await loginAndCreateWorkspace(page, "search-cycle")
  await createChannel(page, `search-cycle-${Date.now().toString(36)}`)

  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()

  // Seed with the stream CLOSED. Sitting in the channel would stream every
  // seeded message into IndexedDB over the socket; a bootstrap hiccup on the
  // later load can then fall back to rendering the full cached history, which
  // puts every match in-window and silently skips the jump path this test
  // exists to exercise.
  await page.goto(`/w/${workspaceId}`)
  await seedMessages(page, workspaceId!, streamId!)
  await page.goto(url)
  await expect(page.locator("[data-message-id]").getByText(`Filler ${TOTAL - 1}:`)).toBeVisible({ timeout: 30_000 })

  await page.keyboard.press("ControlOrMeta+f")
  const input = page.getByPlaceholder("Search in conversation...")
  await input.waitFor()
  await input.pressSequentially("pelican", { delay: 30 })
  // Local phase may briefly count only the in-window match; wait for the server
  // merge to count both.
  await expect(page.getByText("2/2", { exact: true })).toBeVisible({ timeout: 15_000 })

  // Scoped to timeline rows: preview surfaces (sidebar rows, offscreen
  // drawers) can carry the same text and count as "visible" while offscreen.
  const matchVisible = (matchNumber: number) =>
    expect(
      page.locator("[data-message-id]").getByText(`(match ${matchNumber} of ${MATCH_POSITIONS.length})`).first()
    ).toBeVisible({ timeout: 15_000 })

  // Down from the newest match wraps to the oldest — an out-of-window jump.
  await input.press("Enter")
  await matchVisible(1)
  // The regression: this target is near the live tail (hasNewer=false) while a
  // jump window is active — it must render, not freeze on match 1's window.
  await input.press("Enter")
  await matchVisible(2)
  // And back up through the same windows.
  await input.press("Shift+Enter")
  await matchVisible(1)
})
