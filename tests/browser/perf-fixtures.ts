import { type Page } from "@playwright/test"
// Relative, not `@threa/types`: the repo root does not depend on the package,
// so the bare specifier does not resolve here. Type-only, so nothing of the
// package is pulled in at runtime.
import { type PerformanceCapture } from "../../packages/types/src/performance-capture"
import { expectApiOk } from "./helpers"

/**
 * Fixture helpers for performance reproduction specs. Helpers only — no new
 * Playwright project, no timing assertions. Seeding mirrors
 * `infinite-scroll.spec.ts`: batched API posts, batch size 5.
 *
 * The equivalent out-of-band harness is `scripts/perf-seed.ts`; the profiles it
 * exposes and the marks each one proves are in `docs/perf/reproduction-matrix.md`.
 */

const BATCH_SIZE = 5

/** Dev-only arming switch read by `apps/frontend/src/lib/perf/capture.ts`. */
const CAPTURE_STORAGE_KEY = "threa:perf:capture"

/** Post `count` messages carrying `prefix` into a stream, in bounded parallel batches. */
export async function seedStream(
  page: Page,
  workspaceId: string,
  streamId: string,
  count: number,
  prefix: string
): Promise<void> {
  for (let start = 1; start <= count; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, count)
    const batch: Promise<void>[] = []
    for (let i = start; i <= end; i++) {
      batch.push(
        page.request
          .post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId, content: `${prefix} msg-${String(i).padStart(4, "0")}` },
          })
          .then((r) => expectApiOk(r, `Seed message ${i}`))
      )
    }
    await Promise.all(batch)
  }
}

/**
 * Requested body size clamped so the SERIALIZED entry stays within the staging
 * cap. `stageDraftContent` measures `MAX_STAGED_CHARS` against the whole JSON
 * envelope, not the text node, so the largest documented draft size (256 KB)
 * would otherwise write a buffer the app itself would have refused to write.
 */
const MAX_STAGED_CHARS = 256 * 1024

/**
 * Arm the dev capture for every subsequent navigation in this context. Dev
 * arming is local-only and never uploads (`isUploadPermitted` requires
 * consent), so a spec can measure without touching the consent path.
 */
export async function armCapture(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, "1")
  }, CAPTURE_STORAGE_KEY)
}

/** The window handle installed by the provider while armed. */
interface PerfCaptureWindowHandle {
  export: () => PerformanceCapture
  clear: () => void
}

/**
 * Export the armed capture. Waits for the handle: the provider installs it in
 * an effect, so it is not present at first evaluate on a cold load.
 */
export async function readCapture(page: Page, timeout = 20_000): Promise<PerformanceCapture> {
  await page.waitForFunction(
    () => (window as Window & { __threaPerfCapture?: unknown }).__threaPerfCapture !== undefined,
    undefined,
    { timeout }
  )
  return await page.evaluate(() =>
    (window as Window & { __threaPerfCapture?: PerfCaptureWindowHandle }).__threaPerfCapture!.export()
  )
}
