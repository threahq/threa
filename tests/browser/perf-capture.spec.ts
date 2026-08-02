import { test, expect } from "@playwright/test"
import { runTestSql } from "./global-setup"
import { loginAndCreateWorkspace, createChannel } from "./helpers"
import { armCapture, readCapture, seedStream } from "./perf-fixtures"

/**
 * The end-to-end proof for the client capture: it records real phases through a
 * reload, and what it records carries no content. Deliberately free of timing
 * assertions — thresholds are device-dependent and the reproduction matrix is
 * operator-run (`docs/perf/reproduction-matrix.md`).
 */

// Seeding 60 messages over the API plus a cold reload needs headroom in CI.
test.describe.configure({ timeout: 120_000 })

const MESSAGE_COUNT = 60

test.describe("Performance capture", () => {
  test("an armed capture records bootstrap phases across a reload and carries no content", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "perf-capture")
    const channelName = `perf-cap-${testId}`
    await createChannel(page, channelName)

    const url = page.url()
    const workspaceId = url.match(/\/w\/([^/]+)/)![1]!
    const streamId = url.match(/\/s\/([^/?]+)/)![1]!

    // A token that exists nowhere but in the seeded message bodies, so finding
    // it in the capture can only mean content leaked.
    const token = `perfleak${testId}zzz`
    await seedStream(page, workspaceId, streamId, MESSAGE_COUNT, token)

    // Arm before the reload so the provider mounts armed and the bootstrap it
    // measures is a genuinely cold one.
    await armCapture(page)
    await page.reload()
    await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 30_000 })

    // (a) The bootstrap phases. Each is recorded when its phase ENDS, so a
    // first paint (which the cached reveal can produce) does not mean the
    // bootstrap write has landed — poll rather than exporting once. The phases
    // are pinned outside the ring buffer, so nothing evicts them once recorded.
    const BOOTSTRAP_PHASES = ["bootstrap.fetch", "bootstrap.tx", "bootstrap.seed"] as const
    await expect
      .poll(async () => [...new Set((await readCapture(page)).samples.map((s) => s.name))].sort(), {
        timeout: 30_000,
        message: "capture should record every bootstrap phase",
      })
      .toEqual(expect.arrayContaining([...BOOTSTRAP_PHASES]))

    const capture = await readCapture(page)

    // (b) Observer output is machine-dependent — a fast runner may produce no
    // long task at all — so this only asserts something was recorded. Name
    // validity and wire shape are enforced where they can actually fail:
    // `exportCapture` parses `performanceCaptureSchema`, and the schema's
    // rejection cases are covered in packages/types.

    // (c) The privacy proof, over the serialized payload the upload would send.
    const serialized = JSON.stringify(capture)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(channelName)
    expect(serialized).not.toContain(workspaceId)
    expect(serialized).not.toContain(streamId)
  })

  test("a second reload of an idle workspace writes no bootstrap rows", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "perf-diff")
    await createChannel(page, `perf-diff-${testId}`)
    const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]!

    // The workspace layer of `bootstrapDiff`. The region reads
    // `feature_flag_overrides` straight from Postgres on every bootstrap
    // (FeatureFlagOverrideRepository.findLayers, no cache), so the flag is live
    // for the next load with no control-plane round trip.
    runTestSql(
      `INSERT INTO feature_flag_overrides (workspace_id, subject_type, subject_id, flag_key, value)
       VALUES ('${workspaceId}', 'workspace', '${workspaceId}', 'bootstrapDiff', 'on')
       ON CONFLICT (workspace_id, subject_type, subject_id, flag_key) DO UPDATE SET value = EXCLUDED.value`
    )

    await armCapture(page)

    // Three loads, no seeding between any of them. The first applies under the
    // flag and writes everything; the second lets anything the first load itself
    // changed on the server settle (the read watermark it advances is the one
    // such row); only the third is a genuinely unchanged apply. Each load mounts
    // a fresh PerfCapture (`lib/perf/context.tsx` builds one per mount and
    // deletes the window handle on unmount), so the samples read at the end
    // belong to the third load alone.
    for (let load = 0; load < 3; load++) {
      await page.reload()
      await expect(page.getByRole("main").first()).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(async () => (await readCapture(page)).samples.some((s) => s.name === "bootstrap.rowsWritten"), {
          timeout: 30_000,
          message: "capture should record the bootstrap row counts",
        })
        .toBe(true)
    }

    const samples = (await readCapture(page)).samples
    const written = samples.filter((s) => s.name === "bootstrap.rowsWritten").map((s) => s.value)
    const skipped = samples.filter((s) => s.name === "bootstrap.rowsSkipped").map((s) => s.value)

    expect(written.length).toBeGreaterThan(0)
    // The first sample is this load's warm apply; a mid-poll socket reconnect
    // can legitimately append a reconnect apply's non-zero sample after it.
    expect(written[0]).toBe(0)
    expect(Math.max(...skipped)).toBeGreaterThan(0)
  })
})
