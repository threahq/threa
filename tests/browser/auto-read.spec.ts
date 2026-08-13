import { test, expect, type Page, type Browser } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk } from "./helpers"

/**
 * Auto-mark-as-read fires for real: opening an unread stream and reading it
 * (scrolling to the tail, or just having it all on screen) advances the
 * SERVER read state — unreadCounts for the stream reaches 0 without any
 * manual mark. Reported intermittent ("auto read doesn't always fire") after
 * the atomic-landing stack (#1875/#1876) changed when the settle mask clears,
 * which is the arming gate for the read-frontier scan (settledAtBottom in
 * StreamContent).
 *
 * Ground truth is the workspace bootstrap's unreadCounts (server-derived from
 * stream_read_state), not the sidebar badge — the badge has known optimistic
 * races that would mask a server-side miss.
 */

test.describe.configure({ timeout: 120_000 })

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) throw new Error(`Could not extract IDs from URL: ${url}`)
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

async function seedFrom(page: Page, workspaceId: string, streamId: string, count: number, prefix: string, startAt = 1) {
  for (let i = startAt; i < startAt + count; i += 5) {
    const end = Math.min(i + 4, startAt + count - 1)
    await Promise.all(
      Array.from({ length: end - i + 1 }, (_, k) =>
        page.request
          .post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId, content: `${prefix} msg-${String(i + k).padStart(3, "0")}` },
          })
          .then((r) => expectApiOk(r, `Send message ${i + k}`))
      )
    )
  }
}

async function serverUnreadCount(page: Page, workspaceId: string, streamId: string): Promise<number> {
  const res = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(res, "Workspace bootstrap")
  const body = (await res.json()) as { data?: { unreadCounts?: Record<string, number> } }
  const counts = body.data?.unreadCounts
  if (!counts) throw new Error(`Bootstrap response missing unreadCounts; keys: ${Object.keys(body).join(",")}`)
  return counts[streamId] ?? 0
}

async function distanceFromBottom(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.querySelector("[data-suppress-pull-refresh]")
    if (!(el instanceof HTMLElement)) return null
    return el.scrollHeight - el.scrollTop - el.clientHeight
  })
}

/** Owner reads 10 messages, leaves, a second user posts `unreadCount` more. */
async function setUpUnreadChannel(browser: Browser, ownerPage: Page, unreadCount: number) {
  const owner = await loginAndCreateWorkspace(ownerPage, "auto-read")
  const testId = owner.testId
  const prefix = `[${testId}]`

  await createChannel(ownerPage, `autoread-${testId}`)
  const { workspaceId, streamId } = extractIds(ownerPage)

  await expectApiOk(
    await ownerPage.request.patch(`/api/workspaces/${workspaceId}/preferences`, {
      data: { unreadOpenPosition: "marker" },
    }),
    "Set marker preference"
  )

  await seedFrom(ownerPage, workspaceId, streamId, 10, prefix)
  await expect(
    ownerPage
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `${prefix} msg-010` })
  ).toBeVisible({ timeout: 20000 })

  // Navigate away so the unreads arrive while not viewing.
  await ownerPage.goto(`/w/${workspaceId}/drafts`)
  await expect(ownerPage).toHaveURL(new RegExp(`/w/${workspaceId}/drafts`))

  const other = await loginInNewContext(browser, `autoread-b-${testId}@example.com`, `AutoRead B ${testId}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: `AutoRead B ${testId}` },
    }),
    "Second user joins workspace"
  )
  await expectApiOk(
    await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
    "Second user joins the channel"
  )
  await expect
    .poll(
      async () =>
        (
          await other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
            data: { streamId, content: `${prefix}-unread msg-001` },
          })
        ).status(),
      { timeout: 10000, message: "second user's first post should be accepted after joining" }
    )
    .toBe(201)
  if (unreadCount > 1) await seedFrom(other.page, workspaceId, streamId, unreadCount - 1, `${prefix}-unread`, 2)

  // The unread run is real server-side before the owner opens the stream.
  await expect
    .poll(() => serverUnreadCount(ownerPage, workspaceId, streamId), {
      timeout: 10000,
      message: "server should report the seeded unreads",
    })
    .toBeGreaterThanOrEqual(unreadCount)

  return { testId, prefix, workspaceId, streamId, otherContext: other.context }
}

test.describe("Timeline auto-read", () => {
  test("scrolling through the unreads to the tail marks the stream read on the server", async ({ page, browser }) => {
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page, 25)
    await page.setViewportSize({ width: 1024, height: 500 })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    const firstUnread = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `${prefix}-unread msg-001` })
      .first()
    await expect(firstUnread).toBeVisible({ timeout: 20000 })

    // Read down through the unreads to the tail with real wheel gestures.
    const scroller = page.locator("[data-suppress-pull-refresh]")
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 24)
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 300)
          await page.waitForTimeout(120)
          return await distanceFromBottom(page)
        },
        { timeout: 20000, message: "should reach the tail by scrolling" }
      )
      .toBeLessThan(60)

    // Idle past the auto-mark debounce (500ms) + round trip, then the server
    // must agree the stream is fully read.
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "auto-read should clear the server unread count after reading to the tail",
      })
      .toBe(0)

    await otherContext.close()
  })

  test("a message arriving while viewing at the tail re-marks the stream read", async ({ page, browser }) => {
    // The prod signature: watermark written at t, a new message lands at t+4s
    // while the viewer is still on the stream — and no re-mark ever fires,
    // leaving the stream unread-by-one.
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page, 25)
    await page.setViewportSize({ width: 1024, height: 500 })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    const firstUnread = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `${prefix}-unread msg-001` })
      .first()
    await expect(firstUnread).toBeVisible({ timeout: 20000 })

    // Read down to the tail and let the full mark land server-side.
    const scroller = page.locator("[data-suppress-pull-refresh]")
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 24)
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 300)
          await page.waitForTimeout(120)
          return await distanceFromBottom(page)
        },
        { timeout: 20000, message: "should reach the tail by scrolling" }
      )
      .toBeLessThan(60)
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "initial read-through should clear the unread count",
      })
      .toBe(0)

    // A few seconds later — viewer still parked at the tail, no gestures — the
    // other user posts. The new message appends into the followed tail; the
    // read frontier must advance through it and re-mark without any input.
    await page.waitForTimeout(3000)
    const late = await otherContext.pages()[0]!.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: `${prefix}-late arrival msg-999` },
    })
    await expectApiOk(late, "Late arrival message")
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix}-late arrival msg-999` })
    ).toBeVisible({ timeout: 15000 })

    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "arrival while viewing at the tail should re-mark the stream read",
      })
      .toBe(0)

    await otherContext.close()
  })

  test("blur → arrival → refocus → another arrival: every step re-marks once attentive", async ({ page, browser }) => {
    // The prod trace for the reported miss: watermark wrote seconds after a
    // refocus (the parked mark firing), then a message arrived 4s later while
    // still viewing — and no re-mark ever happened. Drive the same focus
    // choreography deterministically.
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page, 25)
    await page.setViewportSize({ width: 1024, height: 500 })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix}-unread msg-001` })
    ).toBeVisible({ timeout: 20000 })

    const scroller = page.locator("[data-suppress-pull-refresh]")
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 24)
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 300)
          await page.waitForTimeout(120)
          return await distanceFromBottom(page)
        },
        { timeout: 20000, message: "should reach the tail by scrolling" }
      )
      .toBeLessThan(60)
    await expect.poll(() => serverUnreadCount(page, workspaceId, streamId), { timeout: 15000 }).toBe(0)

    // Blur the window (attention formula reads document.hasFocus()).
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false })
      window.dispatchEvent(new Event("blur"))
    })

    // A message arrives while blurred — the frontier advances but the mark must
    // park (auto-read requires attention). Server unread stays elevated.
    const other = otherContext.pages()[0]!
    await expectApiOk(
      await other.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: `${prefix}-late blurred-arrival msg-901` },
      }),
      "Arrival while blurred"
    )
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix}-late blurred-arrival msg-901` })
    ).toBeVisible({ timeout: 15000 })
    await page.waitForTimeout(2000)
    expect(await serverUnreadCount(page, workspaceId, streamId), "blurred viewer must not auto-read").toBeGreaterThan(0)

    // Refocus — the parked mark fires.
    await page.evaluate(() => {
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true })
      window.dispatchEvent(new Event("focus"))
    })
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "refocus should release the parked mark",
      })
      .toBe(0)

    // Seconds later, while still focused, another message arrives — this is the
    // step that silently missed in prod.
    await page.waitForTimeout(3000)
    await expectApiOk(
      await other.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: `${prefix}-late focused-arrival msg-902` },
      }),
      "Arrival after refocus"
    )
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix}-late focused-arrival msg-902` })
    ).toBeVisible({ timeout: 15000 })
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "arrival after the refocus mark should re-mark the stream read",
      })
      .toBe(0)

    await otherContext.close()
  })

  test("a fast fling through the unreads to the tail still marks the stream read", async ({ page, browser }) => {
    // The contiguity rule advances the frontier only while consecutive scans
    // overlap. A fast fling (or a busy main thread dropping rAF scans on
    // mobile) moves the viewport more than its own height between scans — the
    // advance silently stops and nothing ever marks, even though every row was
    // painted on the way down. Large wheel deltas reproduce that scan gap
    // deterministically.
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page, 25)
    await page.setViewportSize({ width: 1024, height: 500 })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix}-unread msg-001` })
    ).toBeVisible({ timeout: 20000 })

    const scroller = page.locator("[data-suppress-pull-refresh]")
    const box = await scroller.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 24)
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 2000)
          return await distanceFromBottom(page)
        },
        { timeout: 20000, message: "should reach the tail by flinging" }
      )
      .toBeLessThan(60)

    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "a fast fling to the tail should still mark the stream read",
      })
      .toBe(0)

    await otherContext.close()
  })

  test("jump-to-latest skips the unread block — it stays unread (a jump is a gap, not a sweep)", async ({
    page,
    browser,
  }) => {
    // The counterpart to the fling test: the sweep only links USER scrolling.
    // A programmatic jump from the marker to the tail must not read the block
    // it skipped — the whole point of progressive read.
    // 40 unreads: at the marker landing the tail sits well past the
    // jump-button threshold (600px from the bottom), so the button shows with
    // no scrolling at all — nothing gets read before the jump.
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page, 40)
    await page.setViewportSize({ width: 1024, height: 500 })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix}-unread msg-001` })
    ).toBeVisible({ timeout: 20000 })

    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible({ timeout: 10000 })
    await page.getByRole("button", { name: "Jump to latest" }).click()
    await expect
      .poll(() => distanceFromBottom(page), { timeout: 10000, message: "jump should land at the tail" })
      .toBeLessThan(60)

    // Idle well past the auto-mark debounce; the skipped block must remain
    // unread on the server.
    await page.waitForTimeout(3000)
    expect(
      await serverUnreadCount(page, workspaceId, streamId),
      "the block skipped by the jump must stay unread"
    ).toBeGreaterThan(0)

    await otherContext.close()
  })

  test("a quick triage visit — open, glance, leave — still marks what was on screen", async ({ page, browser }) => {
    // The everyday miss: switch into a stream whose unreads are fully on
    // screen, glance, move on within a second. The mark is debounced 500ms and
    // used to be CANCELLED (not flushed) when the effect tore down on the
    // navigation — the frontier said "seen", the network call never went out,
    // and the stream stayed unread on the server.
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page, 3)
    await page.setViewportSize({ width: 1024, height: 500 })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix}-unread msg-003` })
    ).toBeVisible({ timeout: 20000 })
    // The glance: reveal happened (mask gone), the read-frontier scan has had
    // a beat to run — but we leave before the 500ms debounce fires.
    await expect(page.getByTestId("settle-mask")).toHaveCount(0, { timeout: 10000 })
    await page.waitForTimeout(250)
    await page.getByRole("link", { name: "Drafts" }).click()
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/drafts`))

    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "leaving mid-debounce must flush the pending mark, not drop it",
      })
      .toBe(0)

    await otherContext.close()
  })

  test("a small unread run that fits the viewport marks read with no gesture at all", async ({ page, browser }) => {
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page, 3)
    await page.setViewportSize({ width: 1024, height: 500 })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(
      page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: `${prefix}-unread msg-003` })
    ).toBeVisible({ timeout: 20000 })

    // No scroll, no click — viewing alone must auto-read (the initial frontier
    // scan on settle-complete + ResizeObserver re-scans own this).
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "auto-read should fire with no user gesture when the unreads are all on screen",
      })
      .toBe(0)

    await otherContext.close()
  })
})
