import { execFileSync } from "child_process"
import * as path from "path"
import { test, expect, type Page } from "@playwright/test"
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
 * Runs on the derive path (the `streamContextIndex` flag is off by default), which
 * shares `ContextTimeline`, the virtualizer seam and the day-marker jump with the
 * indexed path — so it exercises the same rendering and scrolling code.
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

/** Same derivation global-setup and playwright.config use. */
function testDatabaseName(): string {
  const explicit = process.env.PLAYWRIGHT_TEST_DB_NAME?.trim()
  if (explicit) return explicit
  const sanitized = path
    .basename(process.cwd())
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
  return `${sanitized || "threa"}_browser_test`
}

/**
 * Backdate half the stream's events so the panel renders more than one day
 * group. Without this every seeded row lands today, and "jump to today" is
 * indistinguishable from the browser restoring focus to the trigger at the top —
 * a jump that moves DOWN to an older day is the assertion focus cannot fake.
 * `docker exec psql` mirrors what global-setup already does for DB work.
 */
function backdateOlderHalf(streamId: string): void {
  const sql = `UPDATE stream_events SET created_at = NOW() - INTERVAL '10 days'
     WHERE stream_id = '${streamId}'
       AND id IN (SELECT id FROM stream_events WHERE stream_id = '${streamId}' ORDER BY sequence LIMIT ${MESSAGE_COUNT / 2})`
  // 10 days back, so the "Last week" preset (7 days) lands on it under the
  // nearest-earlier rule.
  execFileSync("docker", [
    "exec",
    process.env.PLAYWRIGHT_PG_CONTAINER ?? "threapersons-editor-postgres-test-1",
    "psql",
    "-U",
    "threa",
    "-d",
    testDatabaseName(),
    "-c",
    sql,
  ])
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
  backdateOlderHalf(streamId!)
  await page.reload()

  await page.getByRole("button", { name: "In this stream" }).click()
  const scroller = panelScroller(page)
  await expect(scroller).toBeVisible()
  // Link rows carry the host as their title; wait for the feed to render.
  await expect(page.locator('[role="dialog"]').getByText("example.com").first()).toBeVisible()

  // ── Windowing: the scroller reserves the full list height, but only a slice
  // of the rows is mounted. Without virtua every row would be in the DOM.
  const metrics = await scroller.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    mountedRows: el.querySelectorAll('a[href*="example.com"]').length,
  }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight * 2)
  expect(metrics.mountedRows).toBeGreaterThan(0)
  expect(metrics.mountedRows).toBeLessThan(MESSAGE_COUNT / 2)

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

  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(300)
})
