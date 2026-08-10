import { test, expect, type Page } from "@playwright/test"
import { runTestSql } from "./global-setup"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The "In this stream" panel's two behaviours that only exist in a real browser:
 * windowing, and the date jump.
 *
 * Both are invisible to the component tests by construction — `virtua` renders
 * nothing under jsdom's zero-height, no-op-ResizeObserver layout, so every
 * component test swaps the virtualization seam for a passthrough. That leaves
 * "are rows actually windowed" and "does `scrollToIndex` actually move the list"
 * unverified everywhere else.
 *
 * Runs on an ordinary (indexed) channel, with everything the jump needs already
 * loaded. The sibling spec covers the jump that has to page for it.
 */

test.describe.configure({ timeout: 120_000 })

/** Enough link-bearing messages that windowing has something to leave unmounted. */
const MESSAGE_COUNT = 60

async function seedLinkMessages(page: Page, workspaceId: string, streamId: string): Promise<void> {
  const BATCH_SIZE = 6
  for (let start = 1; start <= MESSAGE_COUNT; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, MESSAGE_COUNT)
    const batch: Promise<void>[] = []
    for (let i = start; i <= end; i++) {
      const n = String(i).padStart(3, "0")
      batch.push(
        page.request
          .post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId, content: `artifact ${n} https://example.com/artifact-${n}` },
          })
          .then((r) => expectApiOk(r, `Send message ${i}`))
      )
    }
    await Promise.all(batch)
  }
}

/** Rows left dated today. Everything older is backdated — see below for why so few. */
const TODAY_ROWS = 10

/**
 * Backdate all but the newest {@link TODAY_ROWS} rows, 10 days back so the
 * "Last week" preset (7 days) lands on them under the nearest-earlier rule.
 * Without a second day group there is nothing for a jump to travel to.
 *
 * Two things here are load-bearing and both were got wrong first:
 *
 * `stream_context_items` is the table the panel reads. It groups by `occurredAt`
 * from the projection and never touches `stream_events`, so backdating only the
 * events leaves one day group and every assertion below passes for the wrong
 * reason. The events move too, so the timeline behind the panel agrees.
 *
 * Backdated rows sort to the BOTTOM, so the group's marker has to sit far enough
 * above the end that scrolling it to the top (`align: "start"`) isn't the same
 * scroll position as hitting the bottom. Backdating half put the marker ~10 rows
 * from the end, where the jump and the past-the-start clamp land identically and
 * neither assertion can tell them apart. The endpoint serves 40 rows a page, so
 * leaving 10 today puts the marker around a quarter of the way down.
 */
function backdateAllButNewest(streamId: string): void {
  const older = MESSAGE_COUNT - TODAY_ROWS
  runTestSql(
    `UPDATE stream_events SET created_at = NOW() - INTERVAL '10 days'
       WHERE stream_id = '${streamId}'
         AND id IN (SELECT id FROM stream_events WHERE stream_id = '${streamId}' ORDER BY sequence LIMIT ${older});
     UPDATE stream_context_items SET occurred_at = NOW() - INTERVAL '10 days'
       WHERE stream_id = '${streamId}'
         AND id IN (SELECT id FROM stream_context_items WHERE stream_id = '${streamId}'
                     ORDER BY occurred_at, id LIMIT ${older})`
  )
}

function panelScroller(page: Page) {
  // The panel's own scroller — the element the virtualizer reads metrics from.
  return page.locator('[role="dialog"] .overflow-y-auto').first()
}

test("windows its rows and jumps to a date from a day marker", async ({ page }) => {
  await loginAndCreateWorkspace(page, "context-panel")
  await createChannel(page, `context-${Date.now().toString(36)}`)

  // Both ids come from the URL after the channel is open — the workspace id the
  // creation call returns is not yet routable while provisioning settles.
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()

  await seedLinkMessages(page, workspaceId!, streamId!)
  backdateAllButNewest(streamId!)
  await page.reload()

  await page.getByRole("button", { name: "In this stream" }).click()
  const scroller = panelScroller(page)
  await expect(scroller).toBeVisible()
  // Link rows carry the host as their title; wait for the feed to render.
  await expect(page.locator('[role="dialog"]').getByText("example.com").first()).toBeVisible()

  // ── Windowing: the scroller reserves the full list height, but only a slice
  // of the rows is mounted. Without virtua every row would be in the DOM.
  // Poll the reserved height: virtua grows it as rows are measured, so the
  // first painted row is not the frame where the estimate has settled.
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight / el.clientHeight)).toBeGreaterThan(2)
  const mountedRows = await scroller.evaluate((el) => el.querySelectorAll('a[href*="example.com"]').length)
  expect(mountedRows).toBeGreaterThan(0)
  expect(mountedRows).toBeLessThan(MESSAGE_COUNT / 2)

  // ── Date jump: scroll away, then jump back via a day marker. Every seeded
  // message lands today, so "Today" is the day to return to — what is being
  // verified is that picking a date actually moves the list, which is exactly
  // what jsdom cannot show.
  // Start at the top, then jump to the backdated half — a successful jump moves
  // DOWN the list. Restoring focus to the trigger (which sits at the top) can
  // only scroll up, so this cannot pass unless `scrollToIndex` actually ran.
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }))
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(50)

  await page
    .getByRole("button", { name: /Jump to a date/ })
    .first()
    .click()
  await page.getByRole("button", { name: "Last week", exact: true }).click()

  // Landed ON the backdated day, not merely somewhere below. The bound at the
  // top is what makes this test mean anything: a date the list cannot match
  // clamps to the oldest row (the branch exercised below), which also moves the
  // list down — so a bare "scrolled down" assertion passes whether the jump
  // found the day or gave up on it. The older half starts around the middle.
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight)), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0.15)
  expect(await scroller.evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight))).toBeLessThan(0.9)

  // ── Past the start of history: "Last year" matches no day here, and the
  // useful answer is to travel as far back as the list goes rather than refuse.
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }))
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(50)

  await page
    .getByRole("button", { name: /Jump to a date/ })
    .first()
    .click()
  await page.getByRole("button", { name: "Last year", exact: true }).click()

  // All the way to the oldest row this time — the clamp, not a near miss.
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight)), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0.99)
})
