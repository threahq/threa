import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * A sidebar stream switch must not flicker after first paint: once the
 * cold-load settle mask drops, the revealed timeline holds still — no
 * post-reveal reflow shifting rows under the reader (the "chat flickers on
 * load" report). Content includes image attachments because their late
 * decode/hydration is the reflow suspect; intrinsic dimensions are captured
 * at pick time (#804), so a settled window must not reshape when pixels
 * arrive.
 *
 * The sampler reads scroller metrics every frame from the moment the sidebar
 * link is clicked: while the settle mask is up, movement is expected and
 * hidden (that is the mask's job); flicker is any scrollHeight/scrollTop
 * movement AFTER the first masked-down frame with content.
 */

test.describe.configure({ timeout: 120_000 })

// 1x1 red PNG (same bytes as attachment-stable-urls.spec.ts — known-good upload)
const TEST_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

async function seedMessages(
  page: Page,
  workspaceId: string,
  streamId: string,
  count: number,
  prefix: string,
  startAt = 1
): Promise<void> {
  const BATCH_SIZE = 5
  for (let start = startAt; start < startAt + count; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, startAt + count - 1)
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

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) throw new Error(`Could not extract IDs from URL: ${url}`)
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

/** Paste an image into the visible composer and send it. */
async function sendImageMessage(page: Page): Promise<void> {
  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await page.evaluate(async (imageData) => {
    const editorEl = document.querySelector("[contenteditable='true']")
    if (!editorEl) throw new Error("Editor not found")
    const blob = new Blob([new Uint8Array(imageData)], { type: "image/png" })
    const file = new File([blob], "photo.png", { type: "image/png" })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    editorEl.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer })
    )
  }, Array.from(TEST_PNG))
  await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10000 })
  await page.getByRole("button", { name: "Send", exact: true }).first().click()
  await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(0, { timeout: 15000 })
}

interface FrameSample {
  t: number
  maskUp: boolean
  rows: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Install an open-ended per-frame sampler into the CURRENT document (30s cap). */
function startSampler(page: Page): Promise<void> {
  return page
    .evaluate(() => {
      const out: FrameSample[] = []
      ;(window as unknown as { __stabilitySamples: FrameSample[] }).__stabilitySamples = out
      const start = performance.now()
      const tick = () => {
        const el = document.querySelector("[data-suppress-pull-refresh]")
        const t = Math.round(performance.now() - start)
        if (el instanceof HTMLElement) {
          out.push({
            t,
            maskUp: !!document.querySelector('[data-testid="settle-mask"]'),
            rows: el.querySelectorAll(".message-item").length,
            scrollTop: Math.round(el.scrollTop),
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          })
        } else {
          out.push({ t, maskUp: false, rows: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
        }
        if (t < 30_000) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    .then(() => {})
}

function readSamples(page: Page): Promise<FrameSample[]> {
  return page.evaluate(() => (window as unknown as { __stabilitySamples?: FrameSample[] }).__stabilitySamples ?? [])
}

/**
 * Wait until the sampler has seen the reveal (rows painted, mask down) plus
 * `holdMs` of trailing samples, then assert nothing moved after the reveal.
 * Slow loads under CI contention just extend the wait — the reveal itself is
 * found from the samples, never assumed to happen within a fixed window.
 */
async function expectStablePostReveal(page: Page, holdMs: number, label: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const samples = await readSamples(page)
        const revealIdx = samples.findIndex((s) => s.rows > 0 && !s.maskUp)
        if (revealIdx < 0) return "no-reveal"
        const last = samples[samples.length - 1]
        return last.t - samples[revealIdx].t >= holdMs ? "ready" : "waiting"
      },
      { timeout: 25000, message: `${label}: should reveal and accumulate ${holdMs}ms of post-reveal samples` }
    )
    .toBe("ready")

  const samples = await readSamples(page)
  const revealIdx = samples.findIndex((s) => s.rows > 0 && !s.maskUp)
  // One frame of slack for the reveal commit itself, then two invariants —
  // calibrated for a TAIL landing, where bottom-pinned growth is legitimate
  // (a live message or a late-arriving preview card grows content and the pin
  // absorbs it; the bottom edge is what the reader is anchored to):
  //  - content never SHRINKS (a collapsing preview card, the staging bounce);
  //  - the viewport never drifts off the bottom (distance-from-bottom never
  //    grows — a pin failure would slide the reader up through the content).
  const settled = samples.slice(revealIdx + 2).filter((s) => s.t <= samples[revealIdx].t + holdMs)
  const base = settled[0]
  const baseDist = base.scrollHeight - base.scrollTop - base.clientHeight
  let maxHeight = base.scrollHeight
  const violations: Array<{ sample: FrameSample; why: string }> = []
  for (const s of settled) {
    if (s.scrollHeight < maxHeight - 2) violations.push({ sample: s, why: `content shrank from ${maxHeight}` })
    maxHeight = Math.max(maxHeight, s.scrollHeight)
    const dist = s.scrollHeight - s.scrollTop - s.clientHeight
    if (dist > baseDist + 2) violations.push({ sample: s, why: `drifted off the bottom (base dist ${baseDist})` })
  }
  expect(
    violations.slice(0, 6),
    `${label}: timeline reflowed after reveal (base ${JSON.stringify(base)}; reveal at ${samples[revealIdx].t}ms)`
  ).toEqual([])
}

test.describe("Stream switch stability", () => {
  test("sidebar switch reveals once and holds still — no post-reveal reflow", async ({ page }) => {
    const result = await loginAndCreateWorkspace(page, "switch-stability")
    const testId = result.testId
    const prefix = `[${testId}]`

    // Target channel: an image message (paste flow, same as
    // attachment-stable-urls) followed by a text history, like a real
    // conversation. One paste only — a second paste after API seeding wedges
    // with Send disabled (separate composer issue, not under test here).
    await createChannel(page, `flick-${testId}`)
    const { workspaceId, streamId: targetStreamId } = extractIds(page)
    await sendImageMessage(page)
    await seedMessages(page, workspaceId, targetStreamId, 25, prefix, 1)
    // Link-bearing rows near the tail: their preview cards resolve (or fail)
    // asynchronously after first paint — the classic late-reshape source.
    await page.request
      .post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId: targetStreamId, content: `${prefix} see https://github.com/threahq/threa/pull/1873` },
      })
      .then((r) => expectApiOk(r, "Send link message"))
    await seedMessages(page, workspaceId, targetStreamId, 4, prefix, 27)
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix} msg-030` })
    ).toBeVisible({ timeout: 20000 })

    // Second channel to switch back from.
    await createChannel(page, `other-${testId}`)
    await expect(page.getByRole("heading", { name: `#other-${testId}`, level: 1 })).toBeVisible({ timeout: 10000 })
    await page.setViewportSize({ width: 1024, height: 500 })

    // The switch under test: sidebar link (PUSH) back into the seeded channel.
    // Sampling starts before the click so the whole load is covered; the
    // reveal is found from the samples, never assumed to land in a fixed
    // window (slow CI loads just extend the wait).
    await startSampler(page)
    await page.getByRole("link", { name: `#flick-${testId}` }).click()
    await expectStablePostReveal(page, 1500, "sidebar switch")
  })

  test("reload with dead og-images holds still — error'd preview thumbnails keep their footprint", async ({ page }) => {
    // The staging bounce: og-image URLs that 404 made GenericPreviewContent
    // unmount its fixed thumbnail box ~28px one beat after first paint,
    // reshaping the settled timeline on every reload of a card-heavy stream.
    // Blocking the og-image host forces that error path deterministically —
    // the box must survive with a placeholder and nothing may move.
    const result = await loginAndCreateWorkspace(page, "dead-og")
    const testId = result.testId
    const prefix = `[${testId}]`

    await createChannel(page, `dead-og-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    await seedMessages(page, workspaceId, streamId, 10, prefix, 1)
    await page.request
      .post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: `${prefix} see https://github.com/threahq/threa/pull/1873` },
      })
      .then((r) => expectApiOk(r, "Send link message"))
    await seedMessages(page, workspaceId, streamId, 5, prefix, 12)
    // Wait for the preview card to exist so the reload renders it from the start.
    await expect(page.getByRole("main").locator(".message-item").filter({ hasText: "pull/1873" })).toBeVisible({
      timeout: 20000,
    })

    // Kill every og-image fetch from here on — the reload's cards must render
    // their thumbnail boxes, fail the image, and hold the layout anyway.
    await page.route(
      (url) => /githubassets\.com|githubusercontent\.com|github\.com\/.*\.(png|jpg|svg)/.test(url.href),
      (route) => route.abort()
    )

    // Sample from document start: the aborted image errors (and any collapse)
    // can fire within the first ~100ms of boot, before a post-reload evaluate
    // could attach — an after-the-fact sampler would record only the already-
    // collapsed steady state and pass vacuously.
    await page.addInitScript(() => {
      const out: Array<{ t: number; maskUp: boolean; rows: number; scrollTop: number; scrollHeight: number }> = []
      ;(window as unknown as { __stabilitySamples: typeof out }).__stabilitySamples = out
      const start = performance.now()
      const tick = () => {
        const el = document.querySelector("[data-suppress-pull-refresh]")
        const t = Math.round(performance.now() - start)
        if (el instanceof HTMLElement) {
          out.push({
            t,
            maskUp: !!document.querySelector('[data-testid="settle-mask"]'),
            rows: el.querySelectorAll(".message-item").length,
            scrollTop: Math.round(el.scrollTop),
            scrollHeight: el.scrollHeight,
          })
        } else {
          out.push({ t, maskUp: false, rows: 0, scrollTop: 0, scrollHeight: 0 })
        }
        if (t < 30_000) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    await page.reload()
    await expectStablePostReveal(page, 1500, "dead og-image reload")
  })
})
