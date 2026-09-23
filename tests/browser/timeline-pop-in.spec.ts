import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, generateTestId } from "./helpers"

/**
 * A message that arrives while the reader watches grows in from zero height and
 * pushes the rows above it up.
 *
 * - pinned: the list stays on the bottom every frame of the growth and the row
 *   above the arrival only ever moves up — a frame late on the pin reads as the
 *   new row sliding under the composer, a backwards step as a jitter. Sampled
 *   from a ResizeObserver on the growing row, created after the app's own: it
 *   fires inside the frame, after the app has pinned and before paint, with the
 *   animation clock frozen at the frame's time. A read outside a frame lets
 *   Chrome advance that clock, so it would measure growth nobody painted.
 * - detached: the rows the reader is looking at don't move at all.
 * - cold load: nothing animates.
 * - the viewer's own send grows in like any arrival, and leaves the composer in
 *   the frame its row appears, keeping whatever was typed while it was in flight.
 */

test.describe.configure({ timeout: 120_000 })

const AT_BOTTOM_PX = 1

interface Frame {
  distance: number
  /** Top of the row carrying `anchorText`. */
  anchorTop: number
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

/** Records whether a PopIn animation ever renders, from before the app boots. */
function watchForAnimation() {
  const state = { sawAnimation: false }
  ;(window as unknown as { __popIn: typeof state }).__popIn = state
  new MutationObserver(() => {
    if (document.querySelector(".pop-in-grow, .pop-in-fx")) state.sawAnimation = true
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] })
}

async function sawAnimation(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __popIn: { sawAnimation: boolean } }).__popIn.sawAnimation)
}

/** Samples in-frame geometry every frame the arrival grows. */
function sampleArrival({ anchorText, arrivalText }: { anchorText: string; arrivalText: string }) {
  const frames: Frame[] = []
  ;(window as unknown as { __frames: Frame[] }).__frames = frames
  const rowWith = (text: string) =>
    [...document.querySelectorAll<HTMLElement>("main [data-event-id]")].find((row) => row.textContent?.includes(text))
  let scroller = rowWith(anchorText)!.parentElement!
  while (getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement!
  const resize = new ResizeObserver(() => {
    frames.push({
      distance: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
      anchorTop: Math.round(rowWith(anchorText)!.getBoundingClientRect().top * 10) / 10,
    })
  })
  const mutations = new MutationObserver(() => {
    const growing = rowWith(arrivalText)?.closest(".pop-in-grow")
    if (!growing) return
    mutations.disconnect()
    resize.observe(growing)
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
  await expect(page.locator("main [data-suppress-pull-refresh]").getByText("seed msg-040")).toBeVisible({
    timeout: 30000,
  })
  await page.waitForTimeout(2000)
}

async function expectPinnedArrival(page: Page, workspaceId: string, streamId: string) {
  const arrivalText = `arrival ${generateTestId()}`
  await page.evaluate(sampleArrival, { anchorText: "seed msg-040", arrivalText })
  await postMessage(page, workspaceId, streamId, arrivalText)
  await expect(page.getByRole("main").getByText(arrivalText).first()).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(1000)
  const frames = await page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames)

  // A loaded box paints a 450ms growth in as few as three frames.
  expect(frames.length, "the arrival never grew").toBeGreaterThan(2)
  const offBottom = frames.filter((f) => f.distance > AT_BOTTOM_PX)
  const backwards = frames.filter((f, i) => i > 0 && f.anchorTop > frames[i - 1].anchorTop + 0.5)
  expect({ offBottom, backwards }).toEqual({ offBottom: [], backwards: [] })
}

test("an arrival while pinned grows in and pushes the list up without leaving the bottom", async ({ page }) => {
  const { workspaceId, streamId } = await openSeededChannel(page)
  await page.reload()
  await waitForSettledTail(page)

  await expectPinnedArrival(page, workspaceId, streamId)
})

test("a thread reply while pinned grows in and pushes the thread up without leaving the bottom", async ({ page }) => {
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
  const frames = await page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames)

  expect(frames.length, "the arrival never grew").toBeGreaterThan(2)
  const moved = frames.filter((f) => f.anchorTop !== before.anchorTop)
  expect({ moved, after: await anchorTopNow() }).toEqual({ moved: [], after: before })
})

test("opening a stream animates nothing", async ({ page }) => {
  await openSeededChannel(page)
  await page.addInitScript(watchForAnimation)
  await page.reload()
  await waitForSettledTail(page)

  expect(await sawAnimation(page)).toBe(false)
})

test("your own send grows in and pushes the list up without leaving the bottom", async ({ page }) => {
  await openSeededChannel(page)
  await page.reload()
  await waitForSettledTail(page)

  const text = `own send ${generateTestId()}`
  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(text)
  await page.evaluate(sampleArrival, { anchorText: "seed msg-040", arrivalText: text })
  await page.getByRole("button", { name: "Send", exact: true }).first().click()
  await expect(page.getByRole("main").getByText(text).first()).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(1000)
  const frames = await page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames)

  expect(frames.length, "the send never grew").toBeGreaterThan(2)
  const offBottom = frames.filter((f) => f.distance > AT_BOTTOM_PX)
  const backwards = frames.filter((f, i) => i > 0 && f.anchorTop > frames[i - 1].anchorTop + 0.5)
  expect({ offBottom, backwards }).toEqual({ offBottom: [], backwards: [] })
})

test("your own send leaves the composer in the frame its row appears", async ({ page }) => {
  await openSeededChannel(page)
  await waitForSettledTail(page)

  const text = `own send ${generateTestId()}`
  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(text)
  await page.evaluate((text) => {
    const probe = window as unknown as { __sendGap: boolean }
    probe.__sendGap = false
    const composer = document.querySelector("[contenteditable='true']")!
    const tick = () => {
      const inComposer = composer.textContent?.includes(text) ?? false
      const inTimeline = [...document.querySelectorAll("[data-message-id]")].some((row) =>
        row.textContent?.includes(text)
      )
      if (!inComposer && !inTimeline) probe.__sendGap = true
      if (!inTimeline) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, text)
  await page.keyboard.press("Enter")
  await page.keyboard.type("still typing")

  await expect(page.getByRole("main").getByText(text).first()).toBeVisible({ timeout: 10000 })
  await expect(editor).toHaveText("still typing")
  expect(await page.evaluate(() => (window as unknown as { __sendGap: boolean }).__sendGap)).toBe(false)
})
