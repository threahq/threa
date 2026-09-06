import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, generateTestId } from "./helpers"

/**
 * Sending a message must not move the timeline. The optimistic row appends, the
 * list pins to the bottom, and then the socket echo swaps that row's key from
 * the client id to the event id. That swap looks like a tail replace on shape
 * alone (same count, same first row, new last row), and re-requesting the last
 * index for it hands virtua a deferred scroll that lands after our pin a few px
 * above the true bottom — held there until the dead-band dock smooth-scrolls
 * back down. On a phone that reads as a bounce roughly a second after send.
 *
 * The sampler watches the sent row's own screen position every frame. Once the
 * list has settled at the bottom it must not move again.
 */

test.describe.configure({ timeout: 120_000 })

const MESSAGE = "Tail stability probe"
/** Slack for sub-pixel rounding in getBoundingClientRect. */
const STABLE_PX = 2
/** Distance from the true bottom that still counts as pinned. */
const AT_BOTTOM_PX = 8

interface Sample {
  elapsedMs: number
  distance: number
  lastTop: number
  rows: number
}

async function seedMessages(page: Page, workspaceId: string, streamId: string, count: number): Promise<void> {
  for (let start = 1; start <= count; start += 5) {
    const end = Math.min(start + 4, count)
    await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) => start + i).map((i) =>
        page.request
          .post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId, content: `seed msg-${String(i).padStart(3, "0")} some filler text here` },
          })
          .then((response) => expectApiOk(response, `seed ${i}`))
      )
    )
  }
}

function startSampler(page: Page, durationMs: number): Promise<void> {
  return page.evaluate((duration) => {
    const out: Sample[] = []
    ;(window as unknown as { __tailSamples: Sample[] }).__tailSamples = out
    const start = performance.now()
    const tick = () => {
      const el = document.querySelector("[data-suppress-pull-refresh]")
      if (el instanceof HTMLElement) {
        const rows = el.querySelectorAll(".message-item")
        const last = rows[rows.length - 1]
        out.push({
          elapsedMs: Math.round(performance.now() - start),
          distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
          lastTop: last ? Math.round(last.getBoundingClientRect().top) : -1,
          rows: rows.length,
        })
      }
      if (performance.now() - start < duration) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, durationMs)
}

test("sending a message never displaces the settled tail", async ({ page }) => {
  await loginAndCreateWorkspace(page)
  await createChannel(page, `tail-${generateTestId()}`, { switchToAll: false })
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamId = page.url().match(/\/s\/([^/?]+)/)![1]
  // Enough rows that the list virtualizes and the tail is a real scroll target.
  await seedMessages(page, workspaceId, streamId, 40)

  await page.reload()
  await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 30000 })
  await page.waitForTimeout(3000)

  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(MESSAGE)
  await expect(editor).toContainText(MESSAGE, { timeout: 10000 })

  await startSampler(page, 6000)
  await page.getByRole("button", { name: "Send", exact: true }).first().click()
  // The echo lands within a second; sample well past it so a delayed correction
  // still shows up.
  await page.waitForTimeout(6500)

  const samples: Sample[] = await page.evaluate(
    () => (window as unknown as { __tailSamples: Sample[] }).__tailSamples ?? []
  )
  expect(samples.at(-1)?.elapsedMs, "sampler stopped before the post-echo window").toBeGreaterThanOrEqual(5_500)

  const sentRows = samples[samples.length - 1].rows
  // Settled = the sent row is mounted and the list is pinned to the bottom.
  const settledIdx = samples.findIndex((s) => s.rows === sentRows && s.distance <= AT_BOTTOM_PX && s.lastTop >= 0)
  expect(settledIdx, `never settled: ${JSON.stringify(samples.slice(-5))}`).toBeGreaterThanOrEqual(0)

  const settled = samples.slice(settledIdx)
  const baseline = settled[0].lastTop
  const moved = settled.filter((s) => Math.abs(s.lastTop - baseline) > STABLE_PX)
  expect(moved, `tail moved after settling: ${JSON.stringify(moved.slice(0, 10))}`).toHaveLength(0)

  const unpinned = settled.filter((s) => s.distance > AT_BOTTOM_PX)
  expect(unpinned, `tail left the bottom after settling: ${JSON.stringify(unpinned.slice(0, 10))}`).toHaveLength(0)
})
