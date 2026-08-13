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
}

/** Sample scroller metrics every frame for `ms` after the call. */
function sampleFrames(page: Page, ms: number): Promise<FrameSample[]> {
  return page.evaluate(
    (durationMs) =>
      new Promise<FrameSample[]>((resolve) => {
        const out: FrameSample[] = []
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
          if (performance.now() - start >= durationMs) resolve(out)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    ms
  )
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
    // Sampling starts before the click so the whole load is covered.
    const samplesPromise = sampleFrames(page, 3500)
    await page.getByRole("link", { name: `#flick-${testId}` }).click()
    const samples = await samplesPromise

    // Reveal frame: first frame with content rows and the settle mask down.
    // (While the mask is up, movement is expected and invisible.)
    const revealIdx = samples.findIndex((s) => s.rows > 0 && !s.maskUp)
    expect(revealIdx, `never revealed; samples: ${JSON.stringify(samples.slice(0, 20))}`).toBeGreaterThanOrEqual(0)

    // Give one frame of slack for the reveal commit itself, then everything
    // must hold: any scrollHeight or scrollTop movement is a visible reflow.
    const settled = samples.slice(revealIdx + 2).filter((s) => s.t <= samples[revealIdx].t + 1500)
    expect(settled.length, "should have at least ~1s of post-reveal samples").toBeGreaterThan(20)
    const base = settled[0]
    const moved = settled.filter(
      (s) => Math.abs(s.scrollHeight - base.scrollHeight) > 2 || Math.abs(s.scrollTop - base.scrollTop) > 2
    )
    expect(
      moved.slice(0, 6),
      `timeline reflowed after reveal (base ${JSON.stringify(base)}; reveal at ${samples[revealIdx].t}ms)`
    ).toEqual([])
  })
})
