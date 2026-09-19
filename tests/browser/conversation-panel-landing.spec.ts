import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * INV-70 for the board conversation panel (Mechanism B, `?panel=conv:<id>`).
 * The panel rides the shared timeline engine (`useTimelineScroll` +
 * `VirtualizedScroller`), so its open must decide a landing once and paint
 * there: tail by default, the `?m=` row when deep-linked. The regression this
 * guards is the one the shared engine exists to kill — a tail flash followed by
 * a visible jump, or (before virtualization) a top-anchored first frame that
 * scrolls down to the tail after every row has mounted.
 *
 * Every revealed frame is sampled, so "it ended up right" is not enough: a
 * frame painted outside the mask at the wrong position fails the test.
 */

test.describe.configure({ timeout: 120_000 })

/** The panel's scroller. Scoped by `:has()` — the composer handle also carries
 *  `data-suppress-pull-refresh`, and on `/board` there is no stream timeline. */
const SCROLLER = "[data-suppress-pull-refresh]:has([data-message-id])"
const MESSAGE_COUNT = 40

interface Sample {
  t: number
  distanceFromBottom: number
  clientHeight: number
  masked: boolean
}

/** rAF sampler installed before every navigation: records the panel scroller's
 *  distance from the tail and whether the settle mask still covers it. */
async function installFrameSampler(page: Page): Promise<void> {
  await page.addInitScript(
    ({ scroller }) => {
      const samples: Sample[] = []
      ;(window as unknown as { __panelFrames: Sample[] }).__panelFrames = samples
      const start = performance.now()
      const tick = () => {
        const t = performance.now() - start
        if (t > 20000) return
        const el = document.querySelector(scroller)
        if (el instanceof HTMLElement) {
          samples.push({
            t: Math.round(t),
            distanceFromBottom: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
            clientHeight: el.clientHeight,
            masked: !!document.querySelector('[data-testid="settle-mask"]'),
          })
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { scroller: SCROLLER }
  )
}

async function revealedFrames(page: Page): Promise<Sample[]> {
  const all = await page.evaluate(() => (window as unknown as { __panelFrames?: Sample[] }).__panelFrames ?? [])
  return all.filter((s) => !s.masked)
}

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) throw new Error(`Could not extract IDs from URL: ${url}`)
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

function label(prefix: string, num: number): string {
  return `${prefix} msg-${String(num).padStart(3, "0")}`
}

function rowByNum(page: Page, prefix: string, num: number) {
  return page
    .locator(`${SCROLLER} [data-message-id]`)
    .filter({ hasText: label(prefix, num) })
    .first()
}

/**
 * One conversation spanning `count` messages. The stub boundary extractor gives
 * every channel message its own conversation, so the run is declared instead:
 * `{ intent: "new" }` mints the id, the rest join it by id. Sequential — a
 * parallel batch would land in an arbitrary sequence order and the landing
 * assertions are positional.
 */
async function seedConversation(page: Page, workspaceId: string, streamId: string, count: number, prefix: string) {
  const post = async (num: number, conversation: Record<string, string>) => {
    const res = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: label(prefix, num), conversation },
    })
    await expectApiOk(res, `Send message ${num}`)
    return (await res.json()) as { message: { id: string }; conversationId?: string }
  }

  const opening = await post(1, { intent: "new" })
  const conversationId = opening.conversationId
  if (!conversationId) throw new Error("message create did not return a conversation id for intent:new")

  const messageIds: Record<number, string> = { 1: opening.message.id }
  for (let num = 2; num <= count; num++) {
    messageIds[num] = (await post(num, { intent: "existing", conversationId })).message.id
  }
  return { conversationId, messageIds }
}

async function setUpConversation(page: Page) {
  const { testId } = await loginAndCreateWorkspace(page, "panel-landing")
  await createChannel(page, `panel-landing-${testId}`)
  // Short viewport → genuine virtualization, same rationale as the
  // infinite-scroll specs. Shrunk after createChannel (sidebar overlap).
  await page.setViewportSize({ width: 1024, height: 420 })
  const { workspaceId, streamId } = extractIds(page)
  const prefix = `[${testId}]`
  const seeded = await seedConversation(page, workspaceId, streamId, MESSAGE_COUNT, prefix)
  return { workspaceId, prefix, ...seeded }
}

test.describe("Conversation panel landing", () => {
  test("opens at the tail and every revealed frame is already there", async ({ page }) => {
    const { workspaceId, prefix, conversationId } = await setUpConversation(page)

    await installFrameSampler(page)
    await page.goto(`/w/${workspaceId}/board?panel=conv:${conversationId}`)

    const newest = rowByNum(page, prefix, MESSAGE_COUNT)
    await expect(newest).toBeVisible({ timeout: 30000 })

    const scroller = page.locator(SCROLLER)
    const scrollerBox = await scroller.boundingBox()
    expect(scrollerBox).not.toBeNull()

    // Parked at the tail: the newest row's bottom sits inside the viewport.
    await expect
      .poll(
        async () => {
          const box = await newest.boundingBox()
          return box ? Math.round(scrollerBox!.y + scrollerBox!.height - (box.y + box.height)) : -9999
        },
        { timeout: 15000, message: "newest message should sit at the bottom of the panel" }
      )
      .toBeGreaterThanOrEqual(-4)
    // …and not parked a screenful above it either: the only gap the tail leaves
    // under the newest row is the floating composer's reserve.
    const tailGap = await newest
      .boundingBox()
      .then((box) => scrollerBox!.y + scrollerBox!.height - (box!.y + box!.height))
    expect(tailGap, "newest message should not sit a screenful above the panel bottom").toBeLessThan(
      scrollerBox!.height * 0.5
    )

    // The opening message is 39 rows up, so it must be off-screen.
    const oldestBox = await rowByNum(page, prefix, 1).boundingBox()
    if (oldestBox) {
      expect(oldestBox.y + oldestBox.height, "opening message should be above the viewport").toBeLessThan(
        scrollerBox!.y
      )
    }

    // And it holds — no post-reveal bounce, no drift.
    const posA = (await newest.boundingBox())!.y
    await page.waitForTimeout(1000)
    const posB = (await newest.boundingBox())!.y
    expect(Math.abs(posB - posA)).toBeLessThanOrEqual(3)

    // First paint: every frame painted outside the mask was already at the
    // tail. Tolerance is a quarter of the viewport, not zero — a late height
    // re-measure of the newest row can leave one frame a fraction of a row
    // short before the tail pin corrects it. The regression this guards (a tail
    // flash, or a top-anchored first frame) is a whole viewport out.
    const frames = await revealedFrames(page)
    expect(frames.length, "sampler should have seen revealed frames").toBeGreaterThan(0)
    const strayed = frames.filter((s) => s.distanceFromBottom > s.clientHeight * 0.25)
    expect(strayed, `revealed frames away from the tail: ${JSON.stringify(strayed.slice(0, 10))}`).toHaveLength(0)
  })

  test("a ?m= deep link lands on that message — never a tail flash first", async ({ page }) => {
    const { workspaceId, prefix, conversationId, messageIds } = await setUpConversation(page)
    const targetNum = 6
    const target = messageIds[targetNum]

    await installFrameSampler(page)
    await page.goto(`/w/${workspaceId}/board?panel=conv:${conversationId}&m=${target}`)

    const targetRow = rowByNum(page, prefix, targetNum)
    await expect(targetRow).toBeVisible({ timeout: 30000 })

    const scroller = page.locator(SCROLLER)
    const scrollerBox = await scroller.boundingBox()
    expect(scrollerBox).not.toBeNull()

    // The deep-linked row is inside the viewport, and the panel is detached
    // well clear of the tail (34 rows below it).
    await expect
      .poll(
        async () => {
          const box = await targetRow.boundingBox()
          if (!box) return -9999
          return Math.round(box.y - scrollerBox!.y)
        },
        { timeout: 15000, message: "deep-linked message should be in the panel viewport" }
      )
      .toBeGreaterThanOrEqual(-4)
    const targetBox = (await targetRow.boundingBox())!
    expect(targetBox.y, "deep-linked message should be above the viewport bottom").toBeLessThan(
      scrollerBox!.y + scrollerBox!.height
    )

    const distance = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      return el instanceof HTMLElement ? el.scrollHeight - el.scrollTop - el.clientHeight : -1
    }, SCROLLER)
    expect(distance, "deep link should not park at the tail").toBeGreaterThan(400)

    // Holds: the refine loop settles onto the row and stays.
    const posA = (await targetRow.boundingBox())!.y
    await page.waitForTimeout(1000)
    const posB = (await targetRow.boundingBox())!.y
    expect(Math.abs(posB - posA)).toBeLessThanOrEqual(3)

    // First paint: the tail was never revealed on the way to the deep link.
    const frames = await revealedFrames(page)
    expect(frames.length, "sampler should have seen revealed frames").toBeGreaterThan(0)
    const atTail = frames.filter((s) => s.distanceFromBottom <= 8)
    expect(atTail, `revealed frames at the tail: ${JSON.stringify(atTail.slice(0, 10))}`).toHaveLength(0)
  })
})
