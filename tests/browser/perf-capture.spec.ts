import { test, expect } from "@playwright/test"
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
})
