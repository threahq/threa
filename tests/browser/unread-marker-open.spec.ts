import { test, expect, type Page, type Browser } from "@playwright/test"
import {
  accountStorageKey,
  loginAndCreateWorkspace,
  loginInNewContext,
  createChannel,
  expectApiOk,
  openPhoneSidebar,
  expandCollapsedSidebarSections,
} from "./helpers"

/**
 * Open-at-unread-marker (unreadOpenPosition: "marker"): a stream with unreads
 * opens WITH the first painted frame already at the unread divider — never a
 * tail flash followed by a visible jump up to the divider. Same settle-
 * takeover contract as the anchor restore; this was the "flicker on every
 * unread stream" report once PUSH switches stopped consuming the marker
 * decision via the restore.
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

async function setUpUnreadChannel(browser: Browser, ownerPage: Page, unreadCount = 25) {
  const owner = await loginAndCreateWorkspace(ownerPage, "marker-open")
  const testId = owner.testId
  const prefix = `[${testId}]`

  await createChannel(ownerPage, `marker-${testId}`)
  const { workspaceId, streamId } = extractIds(ownerPage)

  // The viewer opens at the unread marker.
  await expectApiOk(
    await ownerPage.request.patch(`/api/workspaces/${workspaceId}/preferences`, {
      data: { unreadOpenPosition: "marker" },
    }),
    "Set marker preference"
  )

  // Owner seeds some history they have READ (they are viewing the channel).
  await seedFrom(ownerPage, workspaceId, streamId, 10, prefix)
  await expect(
    ownerPage
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `${prefix} msg-010` })
  ).toBeVisible({ timeout: 20000 })

  // Navigate away so the unreads below arrive while not viewing.
  await ownerPage.goto(`/w/${workspaceId}/drafts`)
  await expect(ownerPage).toHaveURL(new RegExp(`/w/${workspaceId}/drafts`))

  // A second user joins and posts the unread run.
  const other = await loginInNewContext(browser, `marker-b-${testId}@example.com`, `Marker B ${testId}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: `Marker B ${testId}` },
    }),
    "Second user joins workspace"
  )
  await expectApiOk(
    await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
    "Second user joins the channel"
  )
  // The join's write authority can lag the join response by a beat under
  // parallel load — poll the first unread post until it lands, then seed.
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
  await seedFrom(other.page, workspaceId, streamId, unreadCount - 1, `${prefix}-unread`, 2)

  return { testId, prefix, workspaceId, streamId, otherContext: other.context }
}

test.describe("Unread marker open", () => {
  for (const viewport of [
    { name: "desktop", width: 1024, height: 500 },
    { name: "phone", width: 388, height: 854 },
  ]) {
    test(`should promptly reveal a warm offline unread target clamped at the tail on ${viewport.name}`, async ({
      page,
      browser,
      context,
    }) => {
      const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page, 1)
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.goto(`/w/${workspaceId}/s/${streamId}`)
        const unread = page
          .locator("main [data-message-id]")
          .filter({ hasText: `${prefix}-unread msg-001` })
          .first()
        await expect(unread).toBeVisible({ timeout: 20_000 })
        await expect(page.getByTestId("settle-mask")).toHaveCount(0)
        const messageId = await unread.getAttribute("data-message-id")
        if (!messageId) throw new Error("Unread target has no message id")

        if (viewport.name === "phone") await openPhoneSidebar(page)
        await page.getByRole("link", { name: "Drafts", exact: true }).first().click()
        await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/drafts`))
        await expectApiOk(
          await page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/unread`, {
            data: { messageId },
          }),
          "Mark the cached target unread"
        )
        if (viewport.name === "phone") await openPhoneSidebar(page)
        await expandCollapsedSidebarSections(page)
        const link = page
          .getByRole("navigation", { name: "Sidebar navigation" })
          .locator(`a[href="/w/${workspaceId}/s/${streamId}"]`)
          .first()
        await expect(link).toBeVisible()
        await expect(link.locator("span.font-semibold").first()).toBeVisible()
        await context.setOffline(true)

        const timing = page.evaluate(
          ({ messageId, streamId }) =>
            new Promise<{ firstMountedAt: number; revealedAt: number; masked: boolean }>((resolve, reject) => {
              let firstMountedAt: number | null = null
              let masked = false
              const started = performance.now()
              const tick = () => {
                const row = document.querySelector<HTMLElement>(
                  `[data-stream-scroller="${streamId}"] [data-message-id="${messageId}"]`
                )
                const mask = document.querySelector('[data-testid="settle-mask"]')
                if (row) {
                  firstMountedAt ??= performance.now()
                  masked ||= Boolean(mask)
                  if (!mask) {
                    resolve({ firstMountedAt, revealedAt: performance.now(), masked })
                    return
                  }
                }
                if (performance.now() - started > 10_000) {
                  reject(new Error("Unread target did not reveal"))
                  return
                }
                requestAnimationFrame(tick)
              }
              requestAnimationFrame(tick)
            }),
          { messageId, streamId }
        )
        await link.click()
        const measured = await timing
        expect(measured.masked, "the unread landing should take over the settle mask").toBe(true)
        expect(measured.revealedAt - measured.firstMountedAt).toBeLessThan(800)
        await expect(unread).toBeInViewport()
        const position = await unread.boundingBox()
        await page.waitForTimeout(1000)
        const heldPosition = await unread.boundingBox()
        expect(position).not.toBeNull()
        expect(heldPosition).not.toBeNull()
        expect(Math.abs(heldPosition!.y - position!.y)).toBeLessThanOrEqual(3)
      } finally {
        await context.setOffline(false)
        await otherContext.close()
      }
    })
  }

  test("sidebar switch into an unread stream paints at the divider — no tail flash, and it holds", async ({
    page,
    browser,
  }) => {
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page)
    await page.setViewportSize({ width: 1024, height: 500 })

    // The switch under test: from /drafts into the unread channel.
    await page.goto(`/w/${workspaceId}/s/${streamId}`)

    // The unread divider ("New" marker) must end up near the viewport top,
    // with the first unread message visible right below it — and hold there.
    const divider = page.getByText("New", { exact: true }).first()
    const firstUnread = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `${prefix}-unread msg-001` })
      .first()
    await expect(firstUnread).toBeVisible({ timeout: 20000 })
    // Visible behind the settle mask while the landing positions it (INV-70); the hold below is about the
    // revealed frame.
    await expect(page.getByTestId("settle-mask")).toHaveCount(0, { timeout: 20000 })

    const scroller = page.locator("[data-suppress-pull-refresh]")
    const scrollerBox = await scroller.boundingBox()
    expect(scrollerBox).not.toBeNull()

    await expect
      .poll(
        async () => {
          const box = await firstUnread.boundingBox()
          return box ? Math.round(box.y - scrollerBox!.y) : -9999
        },
        { timeout: 10000, message: "first unread should sit near the viewport top" }
      )
      .toBeLessThan(200)

    // The tail must NOT be on screen (we are parked at the divider, 25
    // messages above the newest).
    const lastMsg = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `${prefix}-unread msg-025` })
      .first()
    const lastBox = await lastMsg.boundingBox()
    if (lastBox) {
      expect(lastBox.y, "newest message should be below the viewport").toBeGreaterThan(
        scrollerBox!.y + scrollerBox!.height - 10
      )
    }

    // And it holds: the divider position is stable over the next second (the
    // detached viewport guard owns it; late reflows must not slide the view).
    const posA = await firstUnread.boundingBox()
    await page.waitForTimeout(1000)
    const posB = await firstUnread.boundingBox()
    expect(posA).not.toBeNull()
    expect(posB).not.toBeNull()
    expect(Math.abs(posB!.y - posA!.y)).toBeLessThanOrEqual(3)

    await expect(divider).toBeVisible()
    await otherContext.close()
  })

  test("a stale saved anchor falls through to the marker — same atomic decision, no race", async ({
    page,
    browser,
  }) => {
    // INV-70's fallthrough: a persisted reading anchor whose row is no longer
    // in the loaded window must not consume the landing — the resolver falls
    // through to the marker in the SAME decision. A bogus anchor id makes the
    // staleness deterministic.
    const { prefix, workspaceId, streamId, otherContext } = await setUpUnreadChannel(browser, page)
    await page.setViewportSize({ width: 1024, height: 500 })

    await page.evaluate(
      ({ anchorId, anchorsKey }) => {
        localStorage.setItem(
          anchorsKey,
          JSON.stringify({ [anchorId]: { targetId: "msg_00000000000000000000000000", offsetPx: 0, at: Date.now() } })
        )
      },
      { anchorId: `${workspaceId}/${streamId}`, anchorsKey: await accountStorageKey(page, "timeline-anchors") }
    )

    await page.goto(`/w/${workspaceId}/s/${streamId}`)

    const firstUnread = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `${prefix}-unread msg-001` })
      .first()
    await expect(firstUnread).toBeVisible({ timeout: 20000 })

    const scroller = page.locator("[data-suppress-pull-refresh]")
    const scrollerBox = await scroller.boundingBox()
    expect(scrollerBox).not.toBeNull()
    await expect
      .poll(
        async () => {
          const box = await firstUnread.boundingBox()
          return box ? Math.round(box.y - scrollerBox!.y) : -9999
        },
        { timeout: 10000, message: "stale anchor should fall through to the marker landing" }
      )
      .toBeLessThan(200)

    await otherContext.close()
  })
})
