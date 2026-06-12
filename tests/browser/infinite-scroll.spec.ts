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

  // Anchor at the bottom first, then sweep up to the top. A cold virtualized list
  // can mount pinned at the top (the latest message never scrolled into view);
  // from there an up-only wheel produces no scroll movement, so Virtuoso never
  // re-emits the `rangeChanged` that arms the older-page fetch — and reaching the
  // bottom is also what settles its at-bottom gate (the pagination triggers are
  // gated on that). Jumping to the bottom then wheeling up guarantees the top
  // boundary is genuinely re-crossed on every call.
  await page.evaluate(() => {
    const container = document.querySelector("[data-suppress-pull-refresh]")
    if (container instanceof HTMLElement) container.scrollTop = container.scrollHeight
  })
  await page.waitForTimeout(50)

  // Wheel from a point near the TOP of the scroller, not its center. Once we've
  // scrolled up, the floating "Jump to latest" button mounts bottom-center with
  // `pointer-events-auto`; `scroller.hover()` (which targets the center) then
  // throws "subtree intercepts pointer events", and inside an expect.poll that
  // throw is swallowed and retried until the whole test times out. The top strip
  // is never covered by that button.
  const box = await scroller.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + 24)
  }
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -4000)
    await page.waitForTimeout(50)
  }
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
    // A short viewport forces Virtuoso to genuinely virtualize: with the default
    // tall viewport all 50 bootstrap rows render at once, so the scroller barely
    // overflows and reaching the very top (which arms `startReached` → fetch
    // older) is unreliable. A small window keeps the bottom rows unmounted, so a
    // scroll-to-top is a real boundary crossing that paginates deterministically.
    await page.setViewportSize({ width: 1024, height: 400 })

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

    // Navigate to the stream, then hard-reload to force a genuinely cold
    // bootstrap. `createChannel` first navigated into the freshly-created (empty)
    // stream, caching a bootstrap with `hasOlderEvents: false`. Seeding happens
    // over the API while parked on /drafts (no live socket delivery to this
    // client), so re-navigating can keep serving that stale empty-state snapshot
    // — `startReached` then fires on scroll-to-top but bails because the cached
    // `hasOlderEvents` is still false, and the older page never loads. A reload
    // drops the in-memory query cache and refetches the real window (50 events,
    // `hasOlderEvents: true`). Real clients don't hit this — they receive the
    // messages live and invalidate the bootstrap on resubscribe (INV-53).
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    // Let the (possibly stale) first navigation settle before reloading — a
    // reload fired back-to-back with the in-flight goto races its bootstrap and
    // can re-cache the same stale snapshot. Wait for first paint, then reload.
    await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 20000 })
    await page.reload()

    // Wait for the bootstrap window to render. Don't pin on the very latest
    // message being in view: on a loaded runner the virtualized list can mount
    // scrolled to the top of the window (oldest-in-window first) rather than
    // anchored to the bottom, so msg-051 is real but outside the rendered range.
    // Any rendered message confirms the cold bootstrap landed — which is all the
    // scroll-up-loads-older assertion below needs.
    await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 20000 })

    // The earliest message should NOT be in the list yet (beyond the bootstrap window)
    await expect(oldestMessage).toHaveCount(0)

    // Keep nudging the scroller to the top until the older page is fetched and
    // the earliest message is rendered into the virtualized list. We assert it
    // becomes attached (rendered) rather than pixel-visible: a prepend keeps the
    // user's visual position stable by anchoring the previously-top row, so the
    // freshly prepended item sits just above the fold and isn't in the viewport
    // until a further scroll. Whether older messages *load* on scroll-to-top is
    // the behavior under test; the post-prepend scroll-restoration is separate
    // (and exercised via "Jump to latest" below). Virtuoso only mounts rows in
    // its render window, so an attached oldest row proves the scroll reached the
    // top and the older page paginated in.
    await expect
      .poll(
        async () => {
          await scrollToTop(page)
          return await oldestMessage.count()
        },
        {
          timeout: 30000,
          message: "should render older messages after repeated scrolls to the top",
        }
      )
      .toBeGreaterThan(0)
  })

  test("should show skeleton rows while the older page is in flight and hold the viewport when it lands", async ({
    page,
  }) => {
    // Same short-viewport setup as the scroll-older test: forces genuine
    // virtualization so reaching the top is a real boundary crossing.
    await page.setViewportSize({ width: 1024, height: 400 })

    const PAGED_MESSAGE_COUNT = 51
    const channelName = `scroll-skeleton-${testId}`
    await createChannel(page, channelName)

    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`

    // Seed from another route, then reload for a cold bootstrap window with
    // hasOlderEvents: true — see the scroll-older test for why.
    await page.goto(`/w/${workspaceId}/drafts`)
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/drafts`))
    await seedMessages(page, workspaceId, streamId, PAGED_MESSAGE_COUNT, prefix)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 20000 })
    await page.reload()
    await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 20000 })

    // Gate the older-page request so the fetch deterministically stays in
    // flight (well past the skeleton appear delay) until we release it.
    let releaseOlderPage = () => {}
    const olderPageGate = new Promise<void>((resolve) => {
      releaseOlderPage = resolve
    })
    await page.route(
      (url) => url.pathname.endsWith("/events") && url.searchParams.has("before"),
      async (route) => {
        await olderPageGate
        await route.continue()
      }
    )

    // Scroll to the top until the older fetch arms and the skeleton rows
    // render at the head of the timeline.
    const skeletonRows = page.getByTestId("older-skeleton-row")
    await expect
      .poll(
        async () => {
          await scrollToTop(page)
          return await skeletonRows.count()
        },
        { timeout: 30000, message: "should render skeleton rows while the older page is in flight" }
      )
      .toBeGreaterThan(0)

    // The blank space above the loaded window must read as loading: wheel into
    // the skeleton zone and confirm the rows are actually on screen.
    const scroller = page.locator("[data-suppress-pull-refresh]")
    const box = await scroller.boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + 24)
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, -2000)
      await page.waitForTimeout(50)
    }
    await expect(skeletonRows.first()).toBeVisible()

    // Park the viewport just below the skeleton block — the INV-21 guarantee
    // is for content the user is reading below the in-flight zone (a viewport
    // pinned *inside* the skeletons necessarily morphs as they become real
    // rows of different heights).
    await page.evaluate(() => {
      const container = document.querySelector("[data-suppress-pull-refresh]")
      const skeletons = document.querySelectorAll('[data-testid="older-skeleton-row"]')
      const last = skeletons[skeletons.length - 1]
      if (container instanceof HTMLElement && last instanceof HTMLElement) {
        container.scrollTop += last.getBoundingClientRect().bottom - container.getBoundingClientRect().top
      }
    })

    // Anchor on the oldest message of the bootstrap window, sitting at the
    // viewport top directly under the skeleton block.
    const anchor = messageLocator(page, prefix, 2)
    const before = await anchor.boundingBox()
    expect(before).not.toBeNull()

    releaseOlderPage()

    // The page lands: skeletons leave and the older message arrives in one
    // swap...
    const oldestMessage = messageLocator(page, prefix, 1)
    await expect(oldestMessage).toBeAttached({ timeout: 15000 })
    await expect(skeletonRows).toHaveCount(0)

    // ...and the anchored message must not move on screen (INV-21).
    const after = await anchor.boundingBox()
    expect(after).not.toBeNull()
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(5)
  })

  test("should show 'Jump to latest' when scrolled far from bottom and hide when scrolled back", async ({ page }) => {
    // The "Jump to latest" affordance keys off Virtuoso's rendered range
    // (`distFromEnd > 10` items), so it only appears once the bottom of the list
    // is virtualized out of view. On the default tall viewport these 55 short
    // messages all fit inside Virtuoso's render window — the last item stays
    // rendered even at the top, distFromEnd is ~0, and the button never shows.
    // A short viewport forces genuine virtualization, which is the real
    // condition under which the button matters.
    await page.setViewportSize({ width: 1024, height: 400 })

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

    // And with no fetch in flight at the top of history, no skeleton rows
    // may render either.
    await expect(page.getByTestId("older-skeleton-row")).toHaveCount(0)
  })
})
