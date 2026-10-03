import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk } from "./helpers"

/**
 * Opening an unread thread with unreadOpenPosition "marker" paints at the
 * unread divider and stays there. A thread loads every older page on open; a
 * page landing above a reader parked at the marker once read as "the reader is
 * at the bottom" and re-armed tail-follow, so the view jumped to the newest
 * reply a few seconds after it had landed correctly.
 *
 * Runs twice: with the browser's scroll anchoring holding the reader's row, and
 * with it switched off, where only the scroll hook does (iOS Safari has none).
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 412, height: 800 }
// UNREAD_MARKER_TOP_GAP_PX: where a marker landing puts the first unread row.
const LANDING_TOP_PX = 56
// The "Loading older messages..." row (36 px) comes and goes above the reader;
// without scroll anchoring nothing absorbs it.
const LOADING_ROW_PX = 36
const SLACK_PX = 8
const FILLER = "with enough filler text that the row wraps across a few lines on a phone-width timeline"

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) throw new Error(`Could not extract IDs from URL: ${url}`)
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

async function seedReplies(
  page: Page,
  workspaceId: string,
  streamId: string,
  label: string,
  from: number,
  to: number
): Promise<string[]> {
  const ids: string[] = []
  for (let i = from; i <= to; i += 5) {
    const end = Math.min(i + 4, to)
    const batch = await Promise.all(
      Array.from({ length: end - i + 1 }, async (_, k) => {
        const res = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
          data: { streamId, content: `${label}-${String(i + k).padStart(3, "0")} ${FILLER}` },
        })
        await expectApiOk(res, `Send ${label} ${i + k}`)
        return ((await res.json()) as { message: { id: string } }).message.id
      })
    )
    ids.push(...batch)
  }
  return ids
}

async function ensureSidebarOpen(page: Page): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
  const collapse = nav.getByRole("button", { name: "Collapse sidebar" })
  if (await collapse.isVisible().catch(() => false)) return
  // Two toggles carry "Pin sidebar"; only the on-screen one is clickable.
  const toggles = page.getByRole("button", { name: "Pin sidebar" })
  const count = await toggles.count()
  for (let i = 0; i < count; i += 1) {
    const box = await toggles.nth(i).boundingBox()
    if (box && box.x >= 0 && box.x + box.width <= PHONE.width) {
      await toggles.nth(i).click()
      break
    }
  }
  await expect(collapse).toBeVisible({ timeout: 15_000 })
}

interface Frame {
  t: number
  rows: number
  markerTop: number | null
  empty: boolean
}

for (const anchoring of [true, false]) {
  test(`opening an unread thread paints at the marker and holds it while older replies load${anchoring ? "" : ", without scroll anchoring"}`, async ({
    page,
    browser,
  }) => {
    if (!anchoring) {
      await page.addInitScript(() => {
        const supports = CSS.supports.bind(CSS)
        CSS.supports = ((property: string, value?: string) =>
          property !== "overflow-anchor" &&
          (value === undefined ? supports(property) : supports(property, value))) as typeof CSS.supports
      })
    }
    const { testId } = await loginAndCreateWorkspace(page, "thread-marker")
    const prefix = `[${testId}]`

    await createChannel(page, `parent-${testId}`)
    const { workspaceId, streamId: channelId } = extractIds(page)
    await expectApiOk(
      await page.request.patch(`/api/workspaces/${workspaceId}/preferences`, {
        data: { unreadOpenPosition: "marker" },
      }),
      "Set marker preference"
    )

    const anchorRes = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId: channelId, content: `${prefix} thread anchor` },
    })
    await expectApiOk(anchorRes, "Post thread anchor")
    const anchorId = ((await anchorRes.json()) as { message: { id: string } }).message.id
    const threadRes = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "thread", parentStreamId: channelId, parentAnchorId: anchorId },
    })
    await expectApiOk(threadRes, "Create thread")
    const threadId = ((await threadRes.json()) as { stream: { id: string } }).stream.id

    // 60 read replies: more than one page, so opening the thread fetches an
    // older page that lands above the marker. Seeded with no app page open so
    // the socket doesn't cache a partial thread window before the open.
    await page.goto("about:blank")
    const readIds = await seedReplies(page, workspaceId, threadId, `${prefix} read`, 1, 60)
    const listRes = await page.request.get(`/api/workspaces/${workspaceId}/streams/${threadId}/events?limit=50`)
    await expectApiOk(listRes, "List thread events")
    const latestRead = ((await listRes.json()) as { events: Array<{ id: string; sequence: string }> }).events
      .sort((a, b) => Number(a.sequence) - Number(b.sequence))
      .at(-1)
    expect(latestRead).toBeDefined()
    await expectApiOk(
      await page.request.post(`/api/workspaces/${workspaceId}/streams/${threadId}/read`, {
        data: { lastEventId: latestRead!.id },
      }),
      "Mark thread read"
    )

    const other = await loginInNewContext(browser, `thread-marker-b-${testId}@example.com`, `Marker B ${testId}`)
    await expectApiOk(
      await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member", name: `Marker B ${testId}` },
      }),
      "Second user joins workspace"
    )
    await expectApiOk(
      await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${channelId}/join`, { data: {} }),
      "Second user joins the channel"
    )
    // The join's write authority can lag its response under parallel load.
    let firstUnreadId = ""
    await expect
      .poll(
        async () => {
          const res = await other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId: threadId, content: `${prefix} unread-001 ${FILLER}` },
          })
          if (res.status() === 201) firstUnreadId = ((await res.json()) as { message: { id: string } }).message.id
          return res.status()
        },
        { timeout: 10_000, message: "second user's first reply should be accepted after joining" }
      )
      .toBe(201)
    const unreadIds = await seedReplies(other.page, workspaceId, threadId, `${prefix} unread`, 2, 20)

    // Phone size: no desktop sidebar hover warms the thread before the tap.
    await page.setViewportSize(PHONE)
    await page.goto(`/w/${workspaceId}/s/${channelId}`)
    await expect(page.getByTestId("stream-timeline").getByText(`${prefix} thread anchor`)).toBeVisible({
      timeout: 20_000,
    })
    if (!anchoring) await page.addStyleTag({ content: "* { overflow-anchor: none !important; }" })

    // Hold the older page until the landing has handed over, the way a slow
    // network delivers it: after the scroll-to-marker refine loop stopped
    // watching, so only the scroll hook's own bookkeeping decides what happens.
    let releaseOlderPage!: () => void
    const olderPageReleased = new Promise<void>((resolve) => {
      releaseOlderPage = resolve
    })
    let olderPageRequested = false
    await page.route(`**/api/workspaces/${workspaceId}/streams/${threadId}/events?*`, async (route) => {
      if (!new URL(route.request().url()).searchParams.has("before")) return route.continue()
      olderPageRequested = true
      await olderPageReleased
      await route.continue()
    })

    await ensureSidebarOpen(page)
    const threadLink = page.getByRole("navigation", { name: "Sidebar navigation" }).locator(`a[href*="${threadId}"]`)
    await expect(threadLink.first()).toBeVisible({ timeout: 15_000 })

    // Sample every frame from before the tap: the marker row's offset from the
    // top of its scroller, how many thread rows are mounted, and the empty state.
    await page.evaluate(
      ({ markerId, replyIds }) => {
        const replies = new Set(replyIds)
        const frames: Frame[] = []
        ;(window as unknown as { __frames: Frame[] }).__frames = frames
        const start = performance.now()
        const tick = () => {
          const marker = document.querySelector<HTMLElement>(`[data-message-id="${markerId}"]`)
          const scroller = marker?.closest<HTMLElement>(".overflow-y-auto")
          const mounted = new Set<string>()
          for (const n of document.querySelectorAll<HTMLElement>("main [data-message-id]")) {
            const id = n.dataset.messageId
            if (id && replies.has(id)) mounted.add(id)
          }
          const rows = mounted.size
          const empty = Array.from(document.querySelectorAll("main p")).some(
            (n) => n.textContent?.trim() === "No messages yet"
          )
          frames.push({
            t: performance.now() - start,
            rows,
            markerTop:
              marker && scroller
                ? Math.round(marker.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
                : null,
            empty,
          })
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      },
      { markerId: firstUnreadId, replyIds: [...readIds, firstUnreadId, ...unreadIds] }
    )

    await threadLink.first().click()
    await expect(page).toHaveURL(new RegExp(`/s/${threadId}`))
    await expect.poll(() => olderPageRequested, { timeout: 20_000 }).toBe(true)

    const readFrames = () => page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames)
    const lastFrameT = async () => (await readFrames()).at(-1)?.t ?? 0
    const firstRowsAt = async () => (await readFrames()).find((f) => f.rows > 0)?.t ?? null
    await expect.poll(firstRowsAt, { timeout: 20_000 }).not.toBeNull()
    const firstRowsT = (await firstRowsAt())!

    // The refine loop watches for 1.2 s after the landing.
    await expect.poll(lastFrameT, { timeout: 10_000 }).toBeGreaterThan(firstRowsT + 2000)
    const rowsBeforeOlderPage = (await readFrames()).at(-1)!.rows
    releaseOlderPage()

    // The oldest read reply mounts once the older page lands above the reader.
    await expect(page.getByRole("main").getByText(`${prefix} read-001`)).toBeAttached({ timeout: 20_000 })
    const grewAt = await lastFrameT()
    await expect.poll(lastFrameT, { timeout: 10_000 }).toBeGreaterThan(grewAt + 3000)

    const frames = await readFrames()
    const withRows = frames.filter((f) => f.rows > 0)
    const first = withRows[0]
    const maxDrift = (anchoring ? 0 : LOADING_ROW_PX) + SLACK_PX
    const offMarker = (f: Frame) => f.markerTop === null || Math.abs(f.markerTop - LANDING_TOP_PX) > maxDrift
    expect({
      firstFrameAtMarker: !offMarker(first),
      framesOffMarker: withRows.filter(offMarker).slice(0, 3),
      windowGrewUpward: withRows.at(-1)!.rows > rowsBeforeOlderPage,
      emptyStateFrames: frames.filter((f) => f.empty).length,
    }).toEqual({
      firstFrameAtMarker: true,
      framesOffMarker: [],
      windowGrewUpward: true,
      emptyStateFrames: 0,
    })

    await other.context.close()
  })
}
