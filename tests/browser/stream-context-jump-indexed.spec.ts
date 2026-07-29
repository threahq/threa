import { test, expect, type Page } from "@playwright/test"
import { runTestSql } from "./global-setup"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The date jump on the INDEXED path — the one production runs, and the one no
 * other test covers. It differs from the derive path in the part that broke:
 * it pages the feed toward the requested date before scrolling, so the rows it
 * indexes arrive from the server mid-jump rather than being on screen already.
 */

test.describe.configure({ timeout: 600_000 })

/** More than two pages (the endpoint serves 40), so a jump has to page. */
const MESSAGE_COUNT = 60
/** Extra projection rows: enough that the jump pages many times and the render
 *  lags far behind, but still inside its 10-page reach so the oldest day is
 *  actually reachable. */
const BULK_ROWS = 330

async function seedLinkMessages(page: Page, workspaceId: string, streamId: string): Promise<void> {
  const BATCH_SIZE = 10
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

function panelScroller(page: Page) {
  return page.locator('[role="dialog"] .overflow-y-auto').first()
}

test("jumps past the start of history on the indexed path", async ({ page }) => {
  await loginAndCreateWorkspace(page, "context-indexed")
  await createChannel(page, `ctx-idx-${Date.now().toString(36)}`)

  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()

  // The indexed panel is behind a workspace flag. The control plane owns the
  // data but bootstrap resolves it from the region's mirrored copy, which the
  // control plane pushes to on write — so the row goes in the regional table
  // directly, and the page reloads to pick it up.
  runTestSql(
    `INSERT INTO feature_flag_overrides (workspace_id, subject_type, subject_id, flag_key, value)
     VALUES ('${workspaceId}', 'workspace', '${workspaceId}', 'streamContextIndex', 'on')
     ON CONFLICT (workspace_id, subject_type, subject_id, flag_key) DO UPDATE SET value = EXCLUDED.value`
  )

  await seedLinkMessages(page, workspaceId!, streamId!)
  // Deepen the feed without driving hundreds more API calls into the send rate
  // limit — these go straight into the projection the indexed panel reads.
  //
  // They all share ONE day, which is the shape that matters: a busy stream puts
  // hundreds of rows under a single day marker, so the oldest marker sits just
  // below the newest day and is nowhere near the oldest artifact. That is the
  // real feed this was reported against.
  runTestSql(
    `INSERT INTO stream_context_items
       (id, workspace_id, stream_id, root_stream_id, category, ref_kind, ref_id, group_key,
        source_message_id, author_id, occurred_at, sequence, snippet, detail)
     SELECT 'sci_${streamId}_' || n, w.workspace_id, '${streamId}', '${streamId}', 'link', 'url',
            'https://example.com/bulk-' || n, 'https://example.com/bulk-' || n,
            'msg_${streamId}_' || n, w.author_id,
            NOW() - INTERVAL '50 hours', NULL, '', '{}'::jsonb
       FROM generate_series(1, ${BULK_ROWS}) AS n,
            (SELECT workspace_id, author_id FROM stream_context_items
              WHERE stream_id = '${streamId}' LIMIT 1) w`
  )
  await page.reload()

  await page.getByRole("button", { name: "In this stream" }).click()
  const scroller = panelScroller(page)
  await expect(scroller).toBeVisible()
  // The search box only exists on the indexed path — proves the flag took.
  await expect(page.getByPlaceholder(/Search this stream/)).toBeVisible()
  await expect(page.locator('[role="dialog"]').getByText("example.com").first()).toBeVisible()

  await scroller.evaluate((el) => el.scrollTo({ top: 0 }))
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop)).toBeLessThan(50)

  // Nothing here is a year old, so this is the clamp: travel as far back as the
  // feed can page rather than sitting still.
  await page
    .getByRole("button", { name: /Jump to a date/ })
    .first()
    .click()
  await page.getByRole("button", { name: "Last year", exact: true }).click()

  // Past the start of history the answer is the oldest artifact there is, so the
  // list ends up at its bottom. Two ways this falls short and both are real
  // bugs: aiming at the oldest day's MARKER parks the user above however many
  // rows that day holds, and aiming at an index the rendered list does not have
  // yet stops wherever the estimate happened to land.
  await expect
    .poll(async () => scroller.evaluate((el) => el.scrollTop / (el.scrollHeight - el.clientHeight)), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0.99)
})
