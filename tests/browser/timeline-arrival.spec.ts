import { test, expect, type Page, type Route } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, generateTestId } from "./helpers"

/**
 * A message that arrives while the reader watches appears at full height in one
 * frame — no growth.
 *
 * - pinned: the row is in its final place, and the list on the bottom, in the
 *   frame the row first lays out.
 *   Sampled from a ResizeObserver on the new row, created after the app's own: it
 *   fires inside that frame, after the app has pinned and before paint. A read
 *   outside a frame would force layout before the app's pin and see a gap nobody
 *   painted.
 * - detached: the rows the reader is looking at don't move at all.
 * - the viewer's own send leaves the composer at once, keeping whatever is typed
 *   while it is in flight.
 * - a message landing while that send is in flight appears above it, and the
 *   send keeps its place when it confirms.
 */

test.describe.configure({ timeout: 120_000 })

const AT_BOTTOM_PX = 1

interface Frame {
  distance: number
  /** Top of the row carrying `anchorText`. */
  anchorTop: number
  /** Gap between the arrival's bottom edge and the list's; a growing row starts clipped below its final place. */
  arrivalGap: number
}

async function seedMessages(page: Page, workspaceId: string, streamId: string, count: number): Promise<void> {
  for (let start = 1; start <= count; start += 5) {
    const end = Math.min(start + 4, count)
    await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) => start + i).map((i) =>
        postMessage(page, workspaceId, streamId, `seed msg-${String(i).padStart(3, "0")} some filler text here`)
      )
    )
  }
}

async function createThread(page: Page, workspaceId: string, streamId: string, anchorMessageId: string) {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamId, parentAnchorId: anchorMessageId },
  })
  await expectApiOk(response, "create thread")
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function postMessage(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

/** Samples in-frame geometry every frame the arrival's row resizes, starting with the frame it first lays out. */
function sampleArrival({ anchorText, arrivalText }: { anchorText: string; arrivalText: string }) {
  const frames: Frame[] = []
  const laterGaps: number[] = []
  Object.assign(window, { __frames: frames, __laterGaps: laterGaps })
  const rowWith = (text: string) =>
    [...document.querySelectorAll<HTMLElement>("main [data-event-id]")].find((row) => row.textContent?.includes(text))
  let scroller = rowWith(anchorText)!.parentElement!
  while (getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement!
  const gap = () => Math.round(scroller.getBoundingClientRect().bottom - arrival.getBoundingClientRect().bottom)
  // A growing row's inner box never resizes, so the frames after the first are read from rAF.
  const sampleLater = () => {
    laterGaps.push(gap())
    if (laterGaps.length < 30) requestAnimationFrame(sampleLater)
  }
  const resize = new ResizeObserver(() => {
    if (frames.length === 0) requestAnimationFrame(sampleLater)
    frames.push({
      distance: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
      anchorTop: Math.round(rowWith(anchorText)!.getBoundingClientRect().top * 10) / 10,
      arrivalGap: gap(),
    })
  })
  let arrival: HTMLElement
  const mutations = new MutationObserver(() => {
    const row = rowWith(arrivalText)
    if (!row) return
    mutations.disconnect()
    arrival = row
    resize.observe(row)
  })
  mutations.observe(scroller, { subtree: true, childList: true })
}

async function openSeededChannel(page: Page) {
  await loginAndCreateWorkspace(page)
  await createChannel(page, `pop-${generateTestId()}`, { switchToAll: false })
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamId = page.url().match(/\/s\/([^/?]+)/)![1]
  await seedMessages(page, workspaceId, streamId, 40)
  return { workspaceId, streamId }
}

async function waitForSettledTail(page: Page) {
  await expect(page.getByTestId("stream-timeline").getByText("seed msg-040")).toBeVisible({ timeout: 30000 })
  await page.waitForTimeout(2000)
}

async function readFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames)
}

async function readLaterGaps(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __laterGaps: number[] }).__laterGaps)
}

async function arrivalGapNow(page: Page, text: string): Promise<number> {
  return page.evaluate((text) => {
    const row = [...document.querySelectorAll<HTMLElement>("main [data-event-id]")].find((r) =>
      r.textContent?.includes(text)
    )!
    let scroller = row.parentElement!
    while (getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement!
    return Math.round(scroller.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom)
  }, text)
}

/** The row sits in its final place from the first frame it lays out, with the list on the bottom every frame. */
async function expectAppearedPinned(page: Page, text: string) {
  const [frames, laterGaps, finalGap] = [
    await readFrames(page),
    await readLaterGaps(page),
    await arrivalGapNow(page, text),
  ]
  expect(frames.length, "the arrival never laid out").toBeGreaterThan(0)
  const offBottom = frames.filter((f) => f.distance > AT_BOTTOM_PX)
  const misplaced = [frames[0].arrivalGap, ...laterGaps].filter((g) => g !== finalGap)
  expect({ misplaced, offBottom }).toEqual({ misplaced: [], offBottom: [] })
}

async function expectPinnedArrival(page: Page, workspaceId: string, streamId: string) {
  const arrivalText = `arrival ${generateTestId()}`
  await page.evaluate(sampleArrival, { anchorText: "seed msg-040", arrivalText })
  await postMessage(page, workspaceId, streamId, arrivalText)
  await expect(page.getByRole("main").getByText(arrivalText).first()).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(1000)

  await expectAppearedPinned(page, arrivalText)
}

test("an arrival while pinned appears at full height without leaving the bottom", async ({ page }) => {
  const { workspaceId, streamId } = await openSeededChannel(page)
  await page.reload()
  await waitForSettledTail(page)

  await expectPinnedArrival(page, workspaceId, streamId)
})

test("a thread reply while pinned appears at full height without leaving the bottom", async ({ page }) => {
  await loginAndCreateWorkspace(page)
  await createChannel(page, `pop-${generateTestId()}`, { switchToAll: false })
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const channelId = page.url().match(/\/s\/([^/?]+)/)![1]
  const rootId = await postMessage(page, workspaceId, channelId, "thread root")
  const threadId = await createThread(page, workspaceId, channelId, rootId)
  await seedMessages(page, workspaceId, threadId, 40)
  await page.goto(`/w/${workspaceId}/s/${threadId}`)
  await waitForSettledTail(page)

  await expectPinnedArrival(page, workspaceId, threadId)
})

test("an arrival while reading history moves nothing on screen", async ({ page }) => {
  const { workspaceId, streamId } = await openSeededChannel(page)
  await page.reload()
  await waitForSettledTail(page)

  const scroller = page.locator("main [data-suppress-pull-refresh]")
  await scroller.hover()
  await page.mouse.wheel(0, -600)
  await page.waitForTimeout(1000)

  const anchorText = await page.evaluate(() => {
    const el = document.querySelector("main [data-suppress-pull-refresh]")!
    const top = el.getBoundingClientRect().top
    const rows = [...el.querySelectorAll<HTMLElement>("[data-event-id]")]
    const visible = rows.find((r) => r.getBoundingClientRect().top > top + 20)!
    return visible.textContent!.match(/seed msg-\d{3}/)![0]
  })
  const anchorTopNow = () =>
    page.evaluate((text) => {
      const el = document.querySelector("main [data-suppress-pull-refresh]")!
      const row = [...el.querySelectorAll<HTMLElement>("[data-event-id]")].find((r) => r.textContent?.includes(text))!
      return { anchorTop: Math.round(row.getBoundingClientRect().top * 10) / 10, scrollTop: el.scrollTop }
    }, anchorText)
  const before = await anchorTopNow()

  const arrivalText = `arrival ${generateTestId()}`
  await page.evaluate(sampleArrival, { anchorText, arrivalText })
  await postMessage(page, workspaceId, streamId, arrivalText)
  await expect(page.locator("main [data-suppress-pull-refresh]").getByText(arrivalText)).toBeAttached({
    timeout: 10000,
  })
  await page.waitForTimeout(1000)
  const frames = await readFrames(page)

  expect(frames.length, "the arrival never laid out").toBeGreaterThan(0)
  const moved = frames.filter((f) => f.anchorTop !== before.anchorTop)
  expect({ moved, after: await anchorTopNow() }).toEqual({ moved: [], after: before })
})

test("your own send leaves the composer at once and appears pinned, keeping what you type meanwhile", async ({
  page,
}) => {
  await openSeededChannel(page)
  await page.reload()
  await waitForSettledTail(page)

  const text = `own send ${generateTestId()}`
  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(text)
  await page.evaluate(sampleArrival, { anchorText: "seed msg-040", arrivalText: text })
  await page.evaluate((text) => {
    const probe = window as unknown as { __composerInNextFrame: boolean | null }
    probe.__composerInNextFrame = null
    const composer = document.querySelector("[contenteditable='true']")!
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter") return
        requestAnimationFrame(() => (probe.__composerInNextFrame = composer.textContent?.includes(text) ?? false))
      },
      { capture: true, once: true }
    )
  }, text)
  await page.keyboard.press("Enter")
  await page.keyboard.type("still typing")

  await expect(page.getByRole("main").getByText(text).first()).toBeVisible({ timeout: 10000 })
  await expect(editor).toHaveText("still typing")
  await page.waitForTimeout(1000)
  expect(
    await page.evaluate(() => (window as unknown as { __composerInNextFrame: boolean | null }).__composerInNextFrame)
  ).toBe(false)
  await expectAppearedPinned(page, text)
})

/** Records every order `first`/`second` rows render in. */
function watchOrder({ first, second }: { first: string; second: string }) {
  const state = { orders: [] as string[] }
  ;(window as unknown as { __order: typeof state }).__order = state
  const check = () => {
    const rows = [...document.querySelectorAll<HTMLElement>("main [data-event-id]")]
    const a = rows.findIndex((row) => row.textContent?.includes(first))
    const b = rows.findIndex((row) => row.textContent?.includes(second))
    if (a < 0 || b < 0) return
    const order = a < b ? "first above second" : "second above first"
    if (state.orders.at(-1) !== order) state.orders.push(order)
  }
  new MutationObserver(check).observe(document.querySelector("main")!, { subtree: true, childList: true })
}

test("a message landing while your send is in flight appears above it, and your send keeps its place", async ({
  page,
}) => {
  const { workspaceId, streamId } = await openSeededChannel(page)
  await page.reload()
  await waitForSettledTail(page)

  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route(/\/api\/workspaces\/[^/]+\/messages$/, async (route: Route) => {
    if (route.request().method() === "POST") await held
    await route.continue()
  })

  const mine = `mine ${generateTestId()}`
  const theirs = `theirs ${generateTestId()}`
  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(mine)
  await page.evaluate(watchOrder, { first: theirs, second: mine })
  await page.keyboard.press("Enter")
  await expect(page.getByRole("main").getByText(mine)).toBeVisible({ timeout: 10000 })

  await postMessage(page, workspaceId, streamId, theirs)
  await expect(page.locator("main [data-event-id]", { hasText: theirs })).toBeVisible({ timeout: 10000 })
  release()
  await expect(
    page.getByRole("main").locator(`[data-event-id]:not([data-event-id^="temp_"])`, { hasText: mine })
  ).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(500)

  expect(await page.evaluate(() => (window as unknown as { __order: unknown }).__order)).toEqual({
    orders: ["first above second"],
  })
})
