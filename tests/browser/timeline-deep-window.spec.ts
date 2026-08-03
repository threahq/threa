import { test, expect, type Page } from "@playwright/test"
import { runTestSql } from "./global-setup"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"
import { armCapture, readCapture, seedStream } from "./perf-fixtures"

/**
 * Scenario 14 of `docs/perf/reproduction-matrix.md`, as a correctness test: with
 * `boundedTimelineRead` on, the timeline read is split into a bounded tail and a
 * prefix, and a message arriving into a deep scroll-back window must change
 * neither what is rendered around the reader nor where it sits.
 *
 * Scroll position is a layout claim, so it belongs here rather than in jsdom
 * (`gotcha_jsdom_blind_to_layout`): the assertion is the pixel position of an
 * anchor row, read from its bounding box, not `toBeVisible` — a row can be
 * "visible" to Playwright while sitting outside the scroller's viewport. The
 * two-scrollers class of bug (#1717) lives in exactly this path.
 */

// Seeding 160 messages over the API plus repeated scroll-ups needs headroom.
test.describe.configure({ timeout: 180_000 })

const MESSAGE_COUNT = 160
const SCROLLER = "[data-suppress-pull-refresh]"

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  return { workspaceId: url.match(/\/w\/([^/]+)/)![1]!, streamId: url.match(/\/s\/([^/?]+)/)![1]! }
}

function messageLocator(page: Page, prefix: string, num: number) {
  return page
    .getByRole("main")
    .locator(".message-item")
    .filter({ hasText: `${prefix} msg-${String(num).padStart(4, "0")}` })
    .first()
}

/** Wheel up from near the top of the scroller — the strip the "Jump to latest" button never covers. */
async function scrollUp(page: Page): Promise<void> {
  const box = await page.locator(SCROLLER).boundingBox()
  if (!box) return
  await page.mouse.move(box.x + box.width / 2, box.y + 24)
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -4000)
    await page.waitForTimeout(60)
  }
}

test.describe("Bounded timeline read", () => {
  test("a message arriving into a deep scroll-back window does not move the viewport", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "deep-window")
    await createChannel(page, `deep-window-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`

    // The region reads `feature_flag_overrides` straight from Postgres on every
    // bootstrap, so the flag is live for the next load with no round trip.
    runTestSql(
      `INSERT INTO feature_flag_overrides (workspace_id, subject_type, subject_id, flag_key, value)
       VALUES ('${workspaceId}', 'workspace', '${workspaceId}', 'boundedTimelineRead', 'on')
       ON CONFLICT (workspace_id, subject_type, subject_id, flag_key) DO UPDATE SET value = EXCLUDED.value`
    )

    // A short viewport so the list genuinely virtualizes and a scroll-up is a
    // real boundary crossing rather than a no-op on a list that fits.
    await page.setViewportSize({ width: 1024, height: 500 })

    // Seed from another route so the window under test is a cold bootstrap, not
    // a socket-filled one — the seed-with-the-page-open shape skips the very
    // paging path this test needs (`gotcha_browser_spec_false_pass_shapes`).
    await page.goto(`/w/${workspaceId}/drafts`)
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/drafts`))
    await seedStream(page, workspaceId, streamId, MESSAGE_COUNT, prefix)

    await armCapture(page)

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 30_000 })
    await page.reload()
    await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 30_000 })

    // Page back until a message well below the bootstrap window is mounted: this
    // is the deep window whose re-materialisation the split read removes.
    const deepAnchor = messageLocator(page, prefix, 10)
    await expect
      .poll(
        async () => {
          await scrollUp(page)
          return await deepAnchor.count()
        },
        { timeout: 60_000, message: "should page back to a deep scroll-back window" }
      )
      .toBeGreaterThan(0)

    await page.waitForTimeout(500)
    const before = await deepAnchor.boundingBox()
    expect(before).not.toBeNull()
    const scrollTopBefore = await page.locator(SCROLLER).evaluate((el) => el.scrollTop)
    const renderedBefore = await page.getByRole("main").locator(".message-item").count()

    // A second client posts into the stream the reader is scrolled back in.
    await page.request
      .post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: `${prefix} msg-9999 arrival` },
      })
      .then((r) => expectApiOk(r, "post the arriving message"))

    // The arrival must land in the TIMELINE, or the assertions below pass
    // vacuously: a page-wide text poll is satisfied by the sidebar's last-message
    // preview, which updates without the timeline read running at all.
    await expect
      .poll(
        async () =>
          await page
            .getByRole("main")
            .evaluate((el, text) => (el as HTMLElement).innerText.includes(text), `${prefix} msg-9999 arrival`),
        { timeout: 30_000, message: "the arriving message should reach this client's timeline" }
      )
      .toBe(true)
    await page.waitForTimeout(500)

    // The flag actually armed: only the bounded tail read emits this mark.
    const tailSamples = (await readCapture(page)).samples.filter((s) => s.name === "timeline.tailLoad")
    expect(tailSamples.length).toBeGreaterThan(0)

    // The claim: the reader's viewport did not move, and the deep window is
    // still rendered around them (a bounded read that dropped the prefix would
    // shrink the mounted set, not just move it).
    const after = await deepAnchor.boundingBox()
    expect(after).not.toBeNull()
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2)
    const scrollTopAfter = await page.locator(SCROLLER).evaluate((el) => el.scrollTop)
    expect(Math.abs(scrollTopAfter - scrollTopBefore)).toBeLessThanOrEqual(2)
    expect(await page.getByRole("main").locator(".message-item").count()).toBeGreaterThanOrEqual(renderedBefore)
  })
})
