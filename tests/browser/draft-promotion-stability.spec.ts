import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, createScratchpadFromSidebar, generateTestId } from "./helpers"

/**
 * Promoting a draft scratchpad into a real stream must be invisible: the user
 * typed into a draft, hit send, and the view they were already looking at has
 * to keep working. The navigation swaps the whole timeline implementation
 * underneath them (plain draft list -> virtualized stream list) and renames
 * the header, so both a blank frame and a skeleton frame were possible.
 *
 * The sampler reads the visible timeline text every frame from just before the
 * send until well after the URL carries the real stream id. `innerText` is the
 * load-bearing choice: it skips `visibility: hidden`, which is how the
 * virtualizer hides rows it has not measured yet.
 */

test.describe.configure({ timeout: 120_000 })

const MESSAGE = "Promotion stability probe"

interface FrameSample {
  t: number
  path: string
  /** Message text visible (not merely present) in the timeline region. */
  hasRow: boolean
  /** Pulsing placeholder blocks inside the timeline region. */
  skeletons: number
  heading: string
  focused: boolean
}

function startSampler(page: Page): Promise<void> {
  return page.evaluate((message) => {
    const out: FrameSample[] = []
    ;(window as unknown as { __promotionSamples: FrameSample[] }).__promotionSamples = out
    const start = performance.now()
    const tick = () => {
      const t = Math.round(performance.now() - start)
      const region = document.querySelector('[data-testid="stream-timeline"]')
      const active = document.activeElement
      out.push({
        t,
        path: location.pathname,
        hasRow: region instanceof HTMLElement ? region.innerText.includes(message) : false,
        skeletons: region ? region.querySelectorAll(".animate-pulse").length : 0,
        heading: document.querySelector("h1")?.textContent?.trim() ?? "",
        focused: active instanceof HTMLElement && active.isContentEditable,
      })
      if (t < 20_000) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, MESSAGE)
}

function readSamples(page: Page): Promise<FrameSample[]> {
  return page.evaluate(() => (window as unknown as { __promotionSamples: FrameSample[] }).__promotionSamples ?? [])
}

test("promoting a draft scratchpad never blanks or re-skeletons the timeline", async ({ page }) => {
  await loginAndCreateWorkspace(page)
  // The sidebar's All view (where the New Scratchpad entry lives) renders its
  // Channels section only once the workspace has one.
  await createChannel(page, `promo-${generateTestId()}`, { switchToAll: false })
  await createScratchpadFromSidebar(page)
  await expect(page).toHaveURL(/\/s\/draft_/, { timeout: 10000 })

  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(MESSAGE)
  await expect(editor).toContainText(MESSAGE, { timeout: 10000 })

  await startSampler(page)
  await page.getByRole("button", { name: "Send", exact: true }).first().click()
  await expect(page).toHaveURL(/\/s\/stream_/, { timeout: 20000 })
  await page.waitForTimeout(4000)

  const samples = await readSamples(page)
  expect(samples.length).toBeGreaterThan(20)

  const switchIdx = samples.findIndex((s) => /\/s\/stream_/.test(s.path))
  expect(switchIdx).toBeGreaterThanOrEqual(0)

  // The optimistic row paints in the draft view the moment the send is queued;
  // from there it must stay on screen. A dropped frame is the blank timeline
  // the virtualizer's measure gap used to expose.
  const firstRow = samples.findIndex((s) => s.hasRow)
  expect(firstRow).toBeGreaterThanOrEqual(0)
  expect(firstRow).toBeLessThan(switchIdx + 20)
  const blanks = samples.slice(firstRow).filter((s) => !s.hasRow)
  expect(blanks, `blank frames: ${JSON.stringify(blanks.slice(0, 10))}`).toHaveLength(0)

  // No skeleton once real content is on screen: the settle mask over a promoted
  // stream carries the handed-over rows, not placeholders. Bounded to the
  // promotion itself so a later agent-activity card can't muddy the read.
  const settleEnd = samples[switchIdx].t + 2000
  const settleWindow = samples.slice(firstRow).filter((s) => s.t <= settleEnd)
  expect(settleWindow.length).toBeGreaterThan(5)
  const skeletal = settleWindow.filter((s) => s.skeletons > 0)
  expect(skeletal, `skeleton frames: ${JSON.stringify(skeletal.slice(0, 10))}`).toHaveLength(0)

  // The header keeps the unnamed-scratchpad label across the swap; the generic
  // "Untitled" fallback used to flash before the generated name landed.
  const headings = [...new Set(settleWindow.map((s) => s.heading))]
  expect(headings, `headings: ${JSON.stringify(headings)}`).not.toContain("Untitled")

  // The composer the user is still typing into survives the navigation.
  await expect(editor).toBeFocused()
})
