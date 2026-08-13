import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * Landing-at-last-location: a reader who detached from the tail and reloads
 * lands back on the row they were reading — not at the tail (#1868, regressed
 * twice: #1873 revealed the settle at the tail before the anchor scroll
 * landed, then its fix consumed the restore decision during the cold-boot
 * grace window where isLoading is false but the event window is still empty,
 * killing the restore entirely).
 *
 * A real page.reload() is the only faithful repro: it exercises the POP
 * navigation gate, the IDB grace window, the settle mask handoff, and the
 * anchor round-trip through localStorage in one pass — none of which the
 * decision-table unit tests can see.
 *
 * Position assertions go through viewport geometry (bounding rects against
 * the scroller), never Playwright visibility: virtua keeps rows mounted well
 * outside the viewport (bufferSize), so `isVisible` cannot distinguish "on
 * screen" from "mounted two screens away".
 */

test.describe.configure({ timeout: 120_000 })

const MESSAGE_COUNT = 55 // Exceeds the 50-event bootstrap page size

async function seedMessages(
  page: Page,
  workspaceId: string,
  streamId: string,
  count: number,
  prefix: string
): Promise<void> {
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

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) {
    throw new Error(`Could not extract IDs from URL: ${url}`)
  }
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

function messageLocator(page: Page, prefix: string, num: number) {
  return page
    .getByRole("main")
    .locator(".message-item")
    .filter({ hasText: `${prefix} msg-${String(num).padStart(3, "0")}` })
    .first()
}

/** Scroller px between the bottom edge of the viewport and the true bottom. */
async function distanceFromBottom(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector("[data-suppress-pull-refresh]")
    if (!(el instanceof HTMLElement)) return null
    return el.scrollHeight - el.scrollTop - el.clientHeight
  })
}

/** The msg-NNN number of the topmost message row intersecting the viewport. */
async function topVisibleMessageNum(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const scroller = document.querySelector("[data-suppress-pull-refresh]")
    if (!(scroller instanceof HTMLElement)) return null
    const sr = scroller.getBoundingClientRect()
    let best: { num: number; top: number } | null = null
    for (const row of scroller.querySelectorAll<HTMLElement>(".message-item")) {
      const rr = row.getBoundingClientRect()
      if (rr.bottom <= sr.top + 1 || rr.top >= sr.bottom) continue
      const match = row.innerText.match(/msg-(\d+)/)
      if (!match) continue
      if (!best || rr.top < best.top) best = { num: Number(match[1]), top: rr.top }
    }
    return best?.num ?? null
  })
}

test.describe("Timeline anchor restore", () => {
  let testId: string

  test.beforeEach(async ({ page }) => {
    const result = await loginAndCreateWorkspace(page, "anchor-restore")
    testId = result.testId
  })

  test("reload lands on the detached reading position, not the tail, and holds it", async ({ page }) => {
    const channelName = `anchor-${testId}`
    await createChannel(page, channelName)

    // Short viewport → genuine virtualization, same rationale as the
    // infinite-scroll specs. Shrunk after createChannel (sidebar overlap).
    await page.setViewportSize({ width: 1024, height: 400 })

    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`

    await seedMessages(page, workspaceId, streamId, MESSAGE_COUNT, prefix)

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(messageLocator(page, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })

    // Detach a bounded distance up — far enough that the tail is clearly out
    // of the viewport, near enough that the anchored row is comfortably
    // inside the reloaded 50-event bootstrap window (an anchor outside the
    // fresh window is stale and falls through to the next landing in the
    // atomic resolver — the unread marker if one is latched, else the tail;
    // unread-marker-open.spec.ts covers the marker fallthrough).
    // Wheel from near the top edge: the floating jump-to-latest button covers
    // the scroller's center once detached.
    const scroller = page.locator("[data-suppress-pull-refresh]")
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 24)
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -400)
          await page.waitForTimeout(80)
          return await distanceFromBottom(page)
        },
        { timeout: 15000, message: "should detach well clear of the tail" }
      )
      .toBeGreaterThan(600)

    // Let the anchor-capture debounce (250ms) fire on the settled position,
    // then record the topmost on-screen row. That row is what the reload
    // must land on.
    await page.waitForTimeout(500)
    const anchorNum = await topVisibleMessageNum(page)
    expect(anchorNum, "should have a message row at the top of the detached viewport").not.toBeNull()

    await page.reload()
    await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 20000 })

    // The restore lands the same row back at the top of the viewport. ±1 row:
    // the offset round-trip is pixel-faithful, but "topmost visible" is a
    // boundary call — a row cut exactly at the viewport top can classify as
    // its neighbour across a 1px rounding difference without any real drift
    // (observed with byte-identical scrollTop/scrollHeight either side).
    await expect
      .poll(async () => Math.abs(((await topVisibleMessageNum(page)) ?? -999) - anchorNum!), {
        timeout: 20000,
        message: "reload should land on the anchored row, not the tail",
      })
      .toBeLessThanOrEqual(1)
    expect(await distanceFromBottom(page), "should stay detached from the tail after the restore").toBeGreaterThan(400)

    // And it holds: no post-reveal bounce back to the tail (the #1873 tail
    // flash) and no drift. Sample the position over a second.
    const rowBoxA = await messageLocator(page, prefix, anchorNum!).boundingBox()
    expect(rowBoxA).not.toBeNull()
    const samples = await page.evaluate(
      () =>
        new Promise<Array<{ t: number; scrollTop: number; scrollHeight: number }>>((resolve) => {
          const el = document.querySelector("[data-suppress-pull-refresh]") as HTMLElement
          const out: Array<{ t: number; scrollTop: number; scrollHeight: number }> = []
          const start = performance.now()
          const tick = () => {
            out.push({
              t: Math.round(performance.now() - start),
              scrollTop: Math.round(el.scrollTop),
              scrollHeight: el.scrollHeight,
            })
            if (performance.now() - start >= 1000) resolve(out)
            else setTimeout(tick, 100)
          }
          tick()
        })
    )
    expect(
      Math.abs(((await topVisibleMessageNum(page)) ?? -999) - anchorNum!),
      `metrics during hold: ${JSON.stringify(samples)}`
    ).toBeLessThanOrEqual(1)
    const rowBoxB = await messageLocator(page, prefix, anchorNum!).boundingBox()
    expect(rowBoxB).not.toBeNull()
    expect(Math.abs(rowBoxB!.y - rowBoxA!.y), `metrics during hold: ${JSON.stringify(samples)}`).toBeLessThanOrEqual(3)
  })

  test("reload while at the tail stays at the tail (no stale-anchor restore)", async ({ page }) => {
    const channelName = `anchor-tail-${testId}`
    await createChannel(page, channelName)
    await page.setViewportSize({ width: 1024, height: 400 })

    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`

    await seedMessages(page, workspaceId, streamId, MESSAGE_COUNT, prefix)

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(messageLocator(page, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })

    // Following the tail clears any persisted anchor; a reload must land at
    // the tail again.
    await page.waitForTimeout(500)
    await page.reload()
    await expect(messageLocator(page, prefix, MESSAGE_COUNT)).toBeVisible({ timeout: 20000 })
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10000, message: "reload at the tail should land at the tail" })
      .toBeLessThan(150)
  })
})
