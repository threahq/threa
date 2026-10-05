import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, generateTestId } from "./helpers"

/**
 * Sending a message must not move the timeline. The optimistic row appends, the
 * list pins to the bottom, and then the socket echo swaps that row's key from
 * the client id to the event id. That swap looks like a tail replace on shape
 * alone (same count, same first row, new last row), and re-requesting the last
 * index for it hands virtua a deferred scroll that lands after our pin a few px
 * above the true bottom. On a phone that reads as a bounce roughly a second
 * after send.
 *
 * The sampler reads the list's distance from the bottom every frame. Once the
 * sent row is mounted and pinned, the list must never sit off the bottom for
 * two consecutive frames. One frame is the sampler, not the user:
 * requestAnimationFrame runs before the same frame's ResizeObserver, so content
 * landing inside the sent row after the echo (the conversation provenance chip,
 * a link preview) reads as one unpinned frame that the re-pin corrects before
 * paint. The row's own screen position is not asserted for the same reason — a
 * pinned row that grows moves up, and that is correct.
 */

test.describe.configure({ timeout: 120_000 })

const MESSAGE = "Tail stability probe"
/** Distance from the true bottom that still counts as pinned. */
const AT_BOTTOM_PX = 8

interface Sample {
  elapsedMs: number
  distance: number
  /** True once the last row renders the message this test sent. */
  sentRowMounted: boolean
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

function startSampler(page: Page, durationMs: number, message: string): Promise<void> {
  return page.evaluate(
    ({ duration, message }) => {
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
            sentRowMounted: last?.textContent?.includes(message) ?? false,
          })
        }
        if (performance.now() - start < duration) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { duration: durationMs, message }
  )
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

  await startSampler(page, 6000, MESSAGE)
  await page.getByRole("button", { name: "Send", exact: true }).first().click()
  // The echo lands within a second; sample well past it so a delayed correction
  // still shows up.
  await page.waitForTimeout(6500)

  const samples: Sample[] = await page.evaluate(
    () => (window as unknown as { __tailSamples: Sample[] }).__tailSamples ?? []
  )
  expect(samples.at(-1)?.elapsedMs, "sampler stopped before the post-echo window").toBeGreaterThanOrEqual(5_500)

  // Settled = the sent row is mounted and the list is pinned to the bottom.
  const settledIdx = samples.findIndex((s) => s.sentRowMounted && s.distance <= AT_BOTTOM_PX)
  expect(settledIdx, `never settled: ${JSON.stringify(samples.slice(-5))}`).toBeGreaterThanOrEqual(0)

  const settled = samples.slice(settledIdx)
  const held = settled.filter((s, i) => i > 0 && s.distance > AT_BOTTOM_PX && settled[i - 1].distance > AT_BOTTOM_PX)
  expect(held, `tail left the bottom after settling: ${JSON.stringify(held.slice(0, 10))}`).toHaveLength(0)
})

interface SendFrame {
  composerHoldsMessage: boolean
  sentRow: "absent" | "hidden" | "visible"
}

/**
 * Records what each frame paints: the DOM as it stands after that frame's
 * ResizeObserver delivery, which is where the list reveals a row it has just
 * measured. A box resized every frame keeps this observer in that delivery.
 */
function startSendFrameSampler(page: Page, durationMs: number, message: string): Promise<void> {
  return page.evaluate(
    ({ duration, message }) => {
      const out: SendFrame[] = []
      ;(window as unknown as { __sendFrames: SendFrame[] }).__sendFrames = out
      const box = document.createElement("div")
      box.style.cssText = "position:fixed;left:-99px;top:0;width:1px;height:1px;pointer-events:none"
      document.body.appendChild(box)
      const start = performance.now()
      const observer = new ResizeObserver(() => {
        const row = [...document.querySelectorAll<HTMLElement>("main .message-item")].find((candidate) =>
          candidate.textContent?.includes(message)
        )
        let sentRow: SendFrame["sentRow"] = "absent"
        if (row) sentRow = getComputedStyle(row).visibility === "hidden" ? "hidden" : "visible"
        out.push({
          composerHoldsMessage:
            document.querySelector("[contenteditable='true']")?.textContent?.includes(message) ?? false,
          sentRow,
        })
      })
      observer.observe(box)
      const tick = () => {
        if (performance.now() - start >= duration) return observer.disconnect()
        box.style.width = box.style.width === "1px" ? "2px" : "1px"
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { duration: durationMs, message }
  )
}

test("a sent message is on the timeline in the frame the composer clears", async ({ page }) => {
  await loginAndCreateWorkspace(page)
  await createChannel(page, `eager-${generateTestId()}`, { switchToAll: false })
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamId = page.url().match(/\/s\/([^/?]+)/)![1]
  await seedMessages(page, workspaceId, streamId, 40)

  await page.reload()
  await expect(page.getByRole("main").locator(".message-item").first()).toBeVisible({ timeout: 30000 })
  await page.waitForTimeout(3000)

  const message = `Eager row ${generateTestId()}`
  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(message)
  await expect(editor).toContainText(message, { timeout: 10000 })

  await startSendFrameSampler(page, 3000, message)
  await page.keyboard.press("Enter")
  await page.waitForTimeout(3500)

  const frames: SendFrame[] = await page.evaluate(
    () => (window as unknown as { __sendFrames: SendFrame[] }).__sendFrames ?? []
  )
  const cleared = frames.filter((frame) => !frame.composerHoldsMessage)
  expect(cleared.length, "the composer never cleared").toBeGreaterThan(0)
  // The row is written to IndexedDB and read back after the composer has
  // cleared; a frame painted in between shows the message nowhere.
  expect(
    cleared.filter((frame) => frame.sentRow !== "visible"),
    "frames with the composer cleared and the sent row not on screen"
  ).toEqual([])
})
