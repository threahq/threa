import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * Tests for infinite scroll pagination and "Jump to latest" button.
 *
 * These tests create a channel with more than 50 messages (the bootstrap page size)
 * and verify:
 * 1. Bootstrap loads only the most recent batch
 * 2. Scrolling to top fetches older messages
 * 3. "Jump to latest" button appears when scrolled far from bottom
 * 4. Clicking "Jump to latest" scrolls back to the most recent messages
 */

// Seeding 55+ messages via API is slow in CI — give plenty of headroom
test.describe.configure({ timeout: 90_000 })

/** Send N messages to a stream via the API (much faster than typing in the editor). */
async function seedMessages(
  page: Page,
  workspaceId: string,
  streamId: string,
  count: number,
  prefix: string
): Promise<void> {
  // Send in small parallel batches to speed up seeding. Batches are kept small
  // so the assertions that depend on the oldest message (msg-001) staying the
  // single message outside the bootstrap window are not destabilised by
  // within-batch ordering races between concurrent POSTs.
  const BATCH_SIZE = 5
  for (let start = 1; start <= count; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, count)
    const promises: Promise<void>[] = []
    for (let i = start; i <= end; i++) {
      promises.push(
        page.request
          .post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId, content: `${prefix} msg-${String(i).padStart(3, "0")}` },
          })
          .then((r) => expectApiOk(r, `Send message ${i}`))
      )
    }
    await Promise.all(promises)
  }
}

/** Extract workspaceId and streamId from the current URL. */
function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) {
    throw new Error(`Could not extract IDs from URL: ${url}`)
  }
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

/** Locate a specific message by its zero-padded number within the main content area. */
function messageLocator(page: Page, prefix: string, num: number) {
  return page
    .getByRole("main")
    .locator(".message-item")
    .filter({ hasText: `${prefix} msg-${String(num).padStart(3, "0")}` })
    .first()
}

/** Scroll to top and dispatch a scroll event so React's onScroll handler fires. */
async function scrollToTop(page: Page): Promise<void> {
  const scroller = page.locator("[data-suppress-pull-refresh]")
  // The list may not overflow its container (e.g. when only a handful of
  // messages fit on screen). That's a valid state — there is nothing to
  // scroll — so bound the wait and bail out instead of hanging on a
  // waitForFunction that never resolves until the whole test times out.
  const isScrollable = await page
    .waitForFunction(
      () => {
        const container = document.querySelector("[data-suppress-pull-refresh]")
        return container instanceof HTMLElement && container.scrollHeight > container.clientHeight
      },
      undefined,
      { timeout: 5000 }
    )
    .then(() => true)
    .catch(() => false)

  if (!isScrollable) return

  await scroller.hover()
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -4000)
    await page.waitForTimeout(50)
  }

  // Dispatch a few synthetic scroll events because heavily loaded runners can
  // miss a single boundary transition while Virtuoso is still measuring items.
  await page.evaluate(() => {
    const container = document.querySelector("[data-suppress-pull-refresh]")
    if (container instanceof HTMLElement) {
      container.scrollTop = 0
      for (let i = 0; i < 3; i++) {
        container.dispatchEvent(new Event("scroll", { bubbles: true }))
      }
    }
  })
  await page.waitForTimeout(100)
}

test.describe("Infinite Scroll", () => {
  const MESSAGE_COUNT = 55 // Exceeds the 50-event bootstrap page size
  let testId: string

  test.beforeEach(async ({ page }) => {
    const result = await loginAndCreateWorkspace(page, "scroll-test")
    testId = result.testId
  })

  test("should load older messages when scrolling to the top", async ({ page }) => {
    const PAGED_MESSAGE_COUNT = 51 // One item beyond bootstrap is enough to exercise pagination
    const channelName = `scroll-older-${testId}`
    await createChannel(page, channelName)

    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    const oldestMessage = messageLocator(page, prefix, 1)

    // Seed while viewing another route so the target stream doesn't populate its
    // cache via live socket updates before we verify the cold bootstrap window.
    await page.goto(`/w/${workspaceId}/drafts`)
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/drafts`))

    await seedMessages(page, workspaceId, streamId, PAGED_MESSAGE_COUNT, prefix)

    // Navigate fresh to get a clean bootstrap (with only the latest ~50 events)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)

    // Wait for messages to render — the latest message should be visible.
    // Bootstrap render can lag on a loaded CI runner, so allow generous headroom.
    await expect(messageLocator(page, prefix, PAGED_MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })

    // The earliest message should NOT be visible yet (it's beyond the bootstrap window)
    await expect(oldestMessage).not.toBeVisible()

    // Keep nudging the scroller back to the top until the oldest message from
    // the next page is actually rendered. After each prepend the browser keeps
    // the user's visual position stable, so a second scroll-to-top is often
    // required on slower runners before the earliest item is in view.
    await expect
      .poll(
        async () => {
          await scrollToTop(page)
          return await oldestMessage.isVisible()
        },
        {
          timeout: 30000,
          message: "should render older messages after repeated scrolls to the top",
        }
      )
      .toBe(true)
  })

  test("should show 'Jump to latest' when scrolled far from bottom and hide when scrolled back", async ({ page }) => {
    const channelName = `scroll-jump-${testId}`
    await createChannel(page, channelName)

    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`

    await seedMessages(page, workspaceId, streamId, MESSAGE_COUNT, prefix)

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(messageLocator(page, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })

    // "Jump to latest" button should not be visible when at the bottom
    const jumpButton = page.getByRole("button", { name: "Jump to latest" })
    await expect(jumpButton).not.toBeVisible()

    // Scroll to the top
    await expect
      .poll(
        async () => {
          await scrollToTop(page)
          return await jumpButton.isVisible()
        },
        {
          timeout: 15000,
          message: "should show jump-to-latest after scrolling far from the bottom",
        }
      )
      .toBe(true)

    // Click it — should scroll back to bottom
    await jumpButton.click()

    // Button should disappear after scrolling back to bottom
    await expect(jumpButton).not.toBeVisible({ timeout: 10000 })

    // The latest message should be visible again
    await expect(messageLocator(page, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 5000 })
  })

  test("should not make pagination requests when all messages fit in bootstrap", async ({ page }) => {
    const channelName = `scroll-no-page-${testId}`
    await createChannel(page, channelName)

    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`

    // Send only 10 messages — well within the 50-event bootstrap limit
    await seedMessages(page, workspaceId, streamId, 10, prefix)

    // Track event pagination requests
    const eventRequests: Request[] = []
    page.on("request", (request) => {
      if (request.url().includes("/events") && request.url().includes("before=")) {
        eventRequests.push(request)
      }
    })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)

    // First and last messages should be visible
    await expect(messageLocator(page, prefix, 1)).toBeVisible({ timeout: 20000 })
    await expect(messageLocator(page, prefix, 10)).toBeVisible({ timeout: 20000 })

    // Scroll to top
    await scrollToTop(page)

    // Wait a moment to ensure no spurious requests fire
    await page.waitForTimeout(1000)

    // No pagination requests should have been made
    expect(eventRequests.length).toBe(0)
  })
})
