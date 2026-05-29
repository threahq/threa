import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { loginInNewContext, switchToAllView, waitForWorkspaceProvisioned } from "./helpers"

/**
 * Activity feed E2E tests.
 *
 * Tests the full @mention → activity feed flow across two users:
 * 1. User A creates workspace + channel
 * 2. User B joins workspace + channel, opens the workspace in browser
 * 3. User A sends a message mentioning User B by @slug
 * 4. User B sees: mention indicator (@) on stream, activity count on sidebar Activity link
 * 5. User B navigates to Activity page, sees the mention
 * 6. User B clicks activity → navigates to stream, mention indicator clears after reading
 */

/** Stable locator for the Activity sidebar link (accessible name changes when badge appears) */
function activityLink(page: Page, workspaceId: string) {
  return page.locator(`a[href="/w/${workspaceId}/activity"]`)
}

// The Activity badge shows the aggregate unread-activity count, which includes
// incidental rows like the `member_added` activity created when the user joins
// the channel — not just the mention. Match any positive count rather than a
// brittle exact number; mention-specific assertions live on the activity feed.
const ACTIVITY_BADGE_COUNT = /^[1-9]\d*$/

/** Poll the bootstrap until the stream has accrued the expected number of mentions. */
async function waitForMentionCount(page: Page, workspaceId: string, streamId: string, expected: number) {
  await expect
    .poll(
      async () => {
        const bootstrapRes = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
        if (!bootstrapRes.ok()) return -1
        const body = (await bootstrapRes.json()) as { data: { mentionCounts: Record<string, number> } }
        return body.data.mentionCounts[streamId] ?? 0
      },
      { timeout: 20000 }
    )
    .toBe(expected)
}

async function waitForStreamReadState(page: Page, workspaceId: string, streamId: string) {
  await expect
    .poll(
      async () => {
        const bootstrapRes = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
        if (!bootstrapRes.ok()) return -1

        const body = (await bootstrapRes.json()) as {
          data: {
            unreadCounts: Record<string, number>
            mentionCounts: Record<string, number>
            activityCounts: Record<string, number>
          }
        }

        return (
          (body.data.unreadCounts[streamId] ?? 0) +
          (body.data.mentionCounts[streamId] ?? 0) +
          (body.data.activityCounts[streamId] ?? 0)
        )
      },
      { timeout: 20000 }
    )
    .toBe(0)
}

test.describe("Activity Feed", () => {
  test("should show mention badge and activity feed when @mentioned by another user", async ({ browser }) => {
    test.setTimeout(60000)

    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const userAEmail = `mentioner-${testId}@example.com`
    const userAName = `Mentioner ${testId}`
    const userBEmail = `mentionee-${testId}@example.com`
    const userBName = `Mentionee ${testId}`

    // ──── User A: Create workspace + channel via API ────

    const ctxA = await loginInNewContext(browser, userAEmail, userAName)
    let ctxB: { context: BrowserContext; page: Page } | undefined

    try {
      const createWsRes = await ctxA.page.request.post("/api/workspaces", {
        data: { name: `Mention Test ${testId}`, slug: `mention-${testId}` },
      })
      expect(createWsRes.ok()).toBeTruthy()
      const { workspace } = (await createWsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctxA.page, workspaceId)

      const channelSlug = `mentions-${testId}`
      const createStreamRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      expect(createStreamRes.ok()).toBeTruthy()
      const { stream } = (await createStreamRes.json()) as { stream: { id: string } }
      const streamId = stream.id

      // ──── User B: Join workspace + channel via API, then open in browser ────

      ctxB = await loginInNewContext(browser, userBEmail, userBName)

      const joinWsRes = await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member" },
      })
      expect(joinWsRes.ok()).toBeTruthy()
      const { user: userB } = (await joinWsRes.json()) as { user: { id: string; slug: string } }
      const userBSlug = userB.slug

      await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)

      // Navigate User B to the workspace
      await ctxB.page.goto(`/w/${workspaceId}`)
      const actLink = activityLink(ctxB.page, workspaceId)
      await expect(actLink).toBeVisible({ timeout: 10000 })

      // Switch to All view so channel is visible in sidebar
      await switchToAllView(ctxB.page)
      const channelLink = ctxB.page.getByRole("link", { name: `#${channelSlug}` })
      await expect(channelLink).toBeVisible({ timeout: 10000 })

      // ──── User A: Send message mentioning User B ────

      const mentionText = `Hey @${userBSlug} please review this ${testId}`
      const sendMsgRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: mentionText },
      })
      expect(sendMsgRes.ok()).toBeTruthy()

      // ──── User B: Verify mention indicator (@) appears on stream in sidebar ────

      await expect(channelLink.locator("span.text-destructive")).toBeVisible({ timeout: 15000 })

      // ──── User B: Verify activity count badge on Activity link ────

      await expect(actLink.getByText(ACTIVITY_BADGE_COUNT)).toBeVisible({ timeout: 10000 })

      // ──── User B: Navigate to Activity page ────

      await actLink.click()
      await expect(ctxB.page).toHaveURL(new RegExp(`/w/${workspaceId}/activity`))

      // Should see the activity item with actor name and stream context.
      // Scope to the mention row: the feed also lists the member_added row from
      // joining the channel, which references the same #channel — an unscoped
      // getByText(`#${channelSlug}`) would hit a strict-mode violation.
      const mainContent = ctxB.page.getByRole("main")
      const mentionActivity = mainContent.getByRole("link").filter({ hasText: "mentioned you in" })
      await expect(mentionActivity).toBeVisible({ timeout: 10000 })
      await expect(mentionActivity.getByText(`#${channelSlug}`)).toBeVisible()

      // Content preview should include part of the message
      await expect(mentionActivity.getByText(/please review this/)).toBeVisible()

      // ──── User B: Click activity item → navigates to stream ────

      await mentionActivity.click()
      await expect(ctxB.page).toHaveURL(new RegExp(`/w/${workspaceId}/s/${streamId}`))

      // The message should be visible in the stream
      await expect(ctxB.page.getByText(`please review this ${testId}`).first()).toBeVisible({ timeout: 10000 })

      // ──── Verify: Mention indicator cleared after viewing stream ────

      // Wait for backend read-state to settle before asserting sidebar badges.
      await waitForStreamReadState(ctxB.page, workspaceId, streamId)
      await actLink.click()
      await expect(ctxB.page).toHaveURL(new RegExp(`/w/${workspaceId}/activity`))

      // The mention indicator should be gone since stream was read
      await expect(channelLink.locator("span.text-destructive")).not.toBeVisible({ timeout: 10000 })
      await expect(actLink.getByText(ACTIVITY_BADGE_COUNT)).not.toBeVisible({ timeout: 10000 })
    } finally {
      await ctxA.context.close()
      if (ctxB) await ctxB.context.close()
    }
  })

  test("should clear mention indicators when viewing stream receives a mention", async ({ browser }) => {
    test.setTimeout(60000)

    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const userAEmail = `sender-view-${testId}@example.com`
    const userAName = `Sender ${testId}`
    const userBEmail = `viewer-${testId}@example.com`
    const userBName = `Viewer ${testId}`

    const ctxA = await loginInNewContext(browser, userAEmail, userAName)
    let ctxB: { context: BrowserContext; page: Page } | undefined

    try {
      const createWsRes = await ctxA.page.request.post("/api/workspaces", {
        data: { name: `ViewRead Test ${testId}`, slug: `viewread-${testId}` },
      })
      expect(createWsRes.ok()).toBeTruthy()
      const { workspace } = (await createWsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctxA.page, workspaceId)

      const channelSlug = `live-${testId}`
      const createStreamRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      expect(createStreamRes.ok()).toBeTruthy()
      const { stream } = (await createStreamRes.json()) as { stream: { id: string } }
      const streamId = stream.id

      // User B joins workspace + channel
      ctxB = await loginInNewContext(browser, userBEmail, userBName)
      const joinWsRes = await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member" },
      })
      expect(joinWsRes.ok()).toBeTruthy()
      const { user: userB } = (await joinWsRes.json()) as { user: { id: string; slug: string } }

      await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)

      // ──── User B: Navigate directly to the channel (is actively viewing it) ────

      await ctxB.page.goto(`/w/${workspaceId}/s/${streamId}`)
      await expect(ctxB.page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({
        timeout: 10000,
      })

      await switchToAllView(ctxB.page)
      const channelLink = ctxB.page.getByRole("link", { name: `#${channelSlug}` })
      await expect(channelLink).toBeVisible({ timeout: 10000 })
      const actLink = activityLink(ctxB.page, workspaceId)

      // ──── User A: Send message mentioning User B while B is viewing the stream ────

      const mentionText = `Hey @${userB.slug} check this out ${testId}`
      const sendMsgRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: mentionText },
      })
      expect(sendMsgRes.ok()).toBeTruthy()

      // User B should see the message appear in the stream (real-time delivery)
      const mainContent = ctxB.page.getByRole("main")
      await expect(mainContent.getByText(`check this out ${testId}`).first()).toBeVisible({ timeout: 10000 })

      // ──── Verify: Indicators should clear because User B is reading the stream ────

      await waitForStreamReadState(ctxB.page, workspaceId, streamId)

      // Mention indicator should NOT be visible — User B has already read the message
      const mentionIndicator = channelLink.locator("span.text-destructive")
      await expect(mentionIndicator).not.toBeVisible({ timeout: 10000 })

      // Activity count badge should NOT be visible either
      await expect(actLink.getByText("1")).not.toBeVisible({ timeout: 10000 })
    } finally {
      await ctxA.context.close()
      if (ctxB) await ctxB.context.close()
    }
  })

  test("should mark all activity as read", async ({ browser }) => {
    test.setTimeout(60000)

    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const userAEmail = `sender-${testId}@example.com`
    const userAName = `Sender ${testId}`
    const userBEmail = `receiver-${testId}@example.com`
    const userBName = `Receiver ${testId}`

    const ctxA = await loginInNewContext(browser, userAEmail, userAName)
    let ctxB: { context: BrowserContext; page: Page } | undefined

    try {
      const createWsRes = await ctxA.page.request.post("/api/workspaces", {
        data: { name: `MarkRead Test ${testId}`, slug: `markread-${testId}` },
      })
      expect(createWsRes.ok()).toBeTruthy()
      const { workspace } = (await createWsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctxA.page, workspaceId)

      const channelSlug = `chat-${testId}`
      const createStreamRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      expect(createStreamRes.ok()).toBeTruthy()
      const { stream } = (await createStreamRes.json()) as { stream: { id: string } }
      const streamId = stream.id

      // User B joins workspace + channel
      ctxB = await loginInNewContext(browser, userBEmail, userBName)
      const joinWsRes = await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member" },
      })
      expect(joinWsRes.ok()).toBeTruthy()
      const { user: userB } = (await joinWsRes.json()) as { user: { id: string; slug: string } }

      await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)

      // Navigate User B to workspace, switch to All view
      await ctxB.page.goto(`/w/${workspaceId}`)
      const actLink = activityLink(ctxB.page, workspaceId)
      await expect(actLink).toBeVisible({ timeout: 10000 })
      await switchToAllView(ctxB.page)

      // User A sends two messages mentioning User B
      for (const msg of [`First mention @${userB.slug} ${testId}`, `Second mention @${userB.slug} ${testId}`]) {
        const res = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
          data: { streamId, content: msg },
        })
        expect(res.ok()).toBeTruthy()
      }

      // Wait until both mentions have actually been delivered before marking
      // everything read — otherwise a late mention re-raises the badge after the
      // mark-all-read click. Gate on the mention projection (decoupled from the
      // aggregate activity badge, which also counts the join's member_added row).
      await waitForMentionCount(ctxB.page, workspaceId, streamId, 2)
      const channelLink = ctxB.page.getByRole("link", { name: `#${channelSlug}` })
      await expect(actLink.getByText(ACTIVITY_BADGE_COUNT)).toBeVisible({ timeout: 10000 })
      await expect(channelLink.locator("span.text-destructive")).toBeVisible()

      // Navigate to Activity page
      await actLink.click()
      await expect(ctxB.page).toHaveURL(new RegExp(`/w/${workspaceId}/activity`))

      // Should see "Mark all read" button
      const markAllButton = ctxB.page.getByRole("button", { name: "Mark all read" })
      await expect(markAllButton).toBeVisible({ timeout: 10000 })

      // Click it
      await markAllButton.click()

      // The "Mark all read" button should disappear (no more unread activity)
      await expect(markAllButton).not.toBeVisible({ timeout: 5000 })

      // Mention indicator should be cleared
      await expect(channelLink.locator("span.text-destructive")).not.toBeVisible({ timeout: 5000 })
    } finally {
      await ctxA.context.close()
      if (ctxB) await ctxB.context.close()
    }
  })
})
