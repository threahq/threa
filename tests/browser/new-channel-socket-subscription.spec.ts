import { test, expect, type Locator, type Page } from "@playwright/test"
import { createChannel, expectApiOk, loginInNewContext, waitForWorkspaceProvisioned } from "./helpers"

/**
 * Tests that newly created channels receive real-time socket events.
 *
 * Bug: When a user creates a channel, it appears in the sidebar but the
 * client doesn't join the Socket.io room for it. Messages from other users
 * don't update the unread counter or preview until a page refresh.
 */

test.describe("New Channel Socket Subscription", () => {
  async function waitForSidebarPreview(link: Locator, expectedText: string): Promise<void> {
    await expect(link).toBeVisible({ timeout: 10000 })
    await expect
      .poll(async () => ((await link.textContent()) ?? "").toLowerCase(), {
        timeout: 30000,
        message: `sidebar preview should include "${expectedText}"`,
      })
      .toContain(expectedText.toLowerCase())
  }

  async function waitForStreamMessage(page: Page, message: string): Promise<void> {
    await expect(page.getByRole("main").getByText(message, { exact: true }).first()).toBeVisible({ timeout: 45000 })
  }

  async function waitForStreamAccessible(page: Page, workspaceId: string, streamId: string): Promise<void> {
    await expect
      .poll(async () => (await page.request.get(`/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`)).ok(), {
        timeout: 15000,
        intervals: [100, 250, 500, 1000],
        message: `stream ${streamId} should be accessible`,
      })
      .toBe(true)
  }

  test("should make remote channel messages visible without a full page refresh", async ({ browser }) => {
    test.setTimeout(90000)
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

    const userAEmail = `creator-${testId}@example.com`
    const userAName = `Creator ${testId}`
    const userBEmail = `joiner-${testId}@example.com`
    const userBName = `Joiner ${testId}`
    const channelName = `realtime-${testId}`

    // ──── User A: Create workspace and channel ────

    const userA = await loginInNewContext(browser, userAEmail, userAName)
    let userB: Awaited<ReturnType<typeof loginInNewContext>> | undefined

    try {
      const createWorkspaceRes = await userA.page.request.post("/api/workspaces", {
        data: { name: `Socket Sub Test ${testId}` },
      })
      await expectApiOk(createWorkspaceRes, "Create workspace for socket subscription test")
      const workspaceBody = (await createWorkspaceRes.json()) as { workspace: { id: string } }
      const workspaceId = workspaceBody.workspace.id

      await waitForWorkspaceProvisioned(userA.page, workspaceId)
      await userA.page.goto(`/w/${workspaceId}`)
      await expect(userA.page.getByRole("button", { name: "+ New Channel" })).toBeVisible({ timeout: 10000 })

      // Create a channel
      await createChannel(userA.page, channelName, { switchToAll: false })

      // Grab the stream ID from the URL
      const streamMatch = userA.page.url().match(/\/s\/([^/?]+)/)
      expect(streamMatch).toBeTruthy()
      const streamId = streamMatch![1]

      // Send a message so there's something in the channel
      await userA.page.locator("[contenteditable='true']").click()
      await userA.page.keyboard.type("Anyone here?")
      await userA.page.getByRole("button", { name: "Send" }).click()
      await expect(userA.page.getByRole("main").getByText("Anyone here?")).toBeVisible({ timeout: 5000 })

      // Navigate away to a scratchpad via quick switcher (User A is no longer viewing the channel)
      await userA.page.keyboard.press("Meta+k")
      await expect(userA.page.getByRole("dialog")).toBeVisible()
      await userA.page.keyboard.type("> New Scratchpad")
      await userA.page.keyboard.press("Enter")
      await expect(userA.page.getByRole("main").getByText(/Type a message|No messages yet/)).toBeVisible({
        timeout: 5000,
      })

      // Verify the channel link is visible in sidebar (Recent or expanded Everything Else)
      const initialChannelLink = userA.page.locator(`a[href="/w/${workspaceId}/s/${streamId}"]`).first()
      const everythingElseToggle = userA.page.getByRole("button", { name: "Expand Everything Else" })
      if (!(await initialChannelLink.isVisible()) && (await everythingElseToggle.isVisible())) {
        await everythingElseToggle.click()
      }
      await expect(initialChannelLink).toBeVisible({ timeout: 10000 })

      // ──── User B: Join workspace and channel, send a message ────

      userB = await loginInNewContext(browser, userBEmail, userBName)

      // Join workspace via dev endpoint
      const joinWorkspaceRes = await userB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member" },
      })
      expect(joinWorkspaceRes.ok()).toBeTruthy()

      await waitForWorkspaceProvisioned(userB.page, workspaceId)

      // Navigate to workspace so workspace member middleware picks up
      await userB.page.goto(`/w/${workspaceId}`)
      await userB.page.waitForURL(/\/w\//, { timeout: 10000 })

      // Join the channel via dev endpoint
      const joinStreamRes = await userB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)
      expect(joinStreamRes.ok()).toBeTruthy()
      await waitForStreamAccessible(userB.page, workspaceId, streamId)

      // Navigate to the channel and send via UI to avoid API/session race edge-cases
      await userB.page.goto(`/w/${workspaceId}/s/${streamId}`)
      await expect(userB.page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({
        timeout: 10000,
      })
      const joinButtonB = userB.page.getByRole("button", { name: "Join Channel" })
      if (await joinButtonB.isVisible().catch(() => false)) {
        await joinButtonB.click()
        await expect(joinButtonB).not.toBeVisible({ timeout: 5000 })
      }

      const testMessage = `Reply from User B ${Date.now()}`
      await userB.page.locator("[contenteditable='true']").click()
      await userB.page.keyboard.type(testMessage)
      await userB.page.getByRole("button", { name: "Send" }).click()
      await expect(userB.page.getByRole("main").locator(".message-item").getByText(testMessage).first()).toBeVisible({
        timeout: 10000,
      })

      // ──── User A: Channel should remain accessible without refresh ────

      const channelLink = userA.page.locator(`a[href="/w/${workspaceId}/s/${streamId}"]`).first()
      await waitForSidebarPreview(channelLink, testMessage)

      // Click the channel and verify the new message is rendered.
      // The SyncEngine subscribed to the room on stream:created, so User B's
      // message is already in IDB via the socket handlers — no bootstrap
      // refetch is required on navigation.
      await channelLink.click()
      await expect(userA.page).toHaveURL(new RegExp(`/w/${workspaceId}/s/${streamId}`), { timeout: 10000 })
      await expect(userA.page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({
        timeout: 10000,
      })
      await waitForStreamMessage(userA.page, testMessage)
    } finally {
      await userA.context.close()
      if (userB) {
        await userB.context.close()
      }
    }
  })

  test("should keep newly active channels navigable in smart view without refresh", async ({ browser }) => {
    test.setTimeout(90000)
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

    const userAEmail = `preview-creator-${testId}@example.com`
    const userAName = `PreviewCreator ${testId}`
    const userBEmail = `preview-joiner-${testId}@example.com`
    const userBName = `PreviewJoiner ${testId}`
    const channelName = `preview-rt-${testId}`

    // ──── User A: Create workspace and channel ────

    const userA = await loginInNewContext(browser, userAEmail, userAName)
    let userB: Awaited<ReturnType<typeof loginInNewContext>> | undefined

    try {
      const createWorkspaceRes = await userA.page.request.post("/api/workspaces", {
        data: { name: `Preview Sub Test ${testId}` },
      })
      await expectApiOk(createWorkspaceRes, "Create workspace for preview subscription test")
      const workspaceBody = (await createWorkspaceRes.json()) as { workspace: { id: string } }
      const workspaceId = workspaceBody.workspace.id

      await waitForWorkspaceProvisioned(userA.page, workspaceId)
      await userA.page.goto(`/w/${workspaceId}`)
      await expect(userA.page.getByRole("button", { name: "+ New Channel" })).toBeVisible({ timeout: 10000 })

      // Create channel
      await createChannel(userA.page, channelName, { switchToAll: false })

      const streamMatch = userA.page.url().match(/\/s\/([^/?]+)/)
      const streamId = streamMatch![1]

      // Navigate away via quick switcher
      await userA.page.keyboard.press("Meta+k")
      await expect(userA.page.getByRole("dialog")).toBeVisible()
      await userA.page.keyboard.type("> New Scratchpad")
      await userA.page.keyboard.press("Enter")
      await expect(userA.page.getByRole("main").getByText(/Type a message|No messages yet/)).toBeVisible({
        timeout: 5000,
      })

      // ──── User B: Join and send a message ────

      userB = await loginInNewContext(browser, userBEmail, userBName)

      const joinWorkspaceRes = await userB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member" },
      })
      await expectApiOk(joinWorkspaceRes, "Join workspace for preview subscription test")
      await waitForWorkspaceProvisioned(userB.page, workspaceId)
      await userB.page.goto(`/w/${workspaceId}`)
      await userB.page.waitForURL(/\/w\//, { timeout: 10000 })

      const joinStreamRes = await userB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)
      await expectApiOk(joinStreamRes, "Join stream for preview subscription test")
      await waitForStreamAccessible(userB.page, workspaceId, streamId)

      await userB.page.goto(`/w/${workspaceId}/s/${streamId}`)
      await expect(userB.page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({
        timeout: 10000,
      })
      const joinButtonB = userB.page.getByRole("button", { name: "Join Channel" })
      if (await joinButtonB.isVisible().catch(() => false)) {
        await joinButtonB.click()
        await expect(joinButtonB).not.toBeVisible({ timeout: 5000 })
      }

      const previewMessage = `Preview check ${Date.now()}`
      await userB.page.locator("[contenteditable='true']").click()
      await userB.page.keyboard.type(previewMessage)
      await userB.page.getByRole("button", { name: "Send" }).click()
      await waitForStreamMessage(userB.page, previewMessage)

      // ──── User A: Channel should be reachable from sidebar without refresh ────

      const channelLink = userA.page.locator(`a[href="/w/${workspaceId}/s/${streamId}"]`).first()

      const everythingElseToggle = userA.page.getByRole("button", { name: "Expand Everything Else" })
      if (await everythingElseToggle.isVisible()) {
        await everythingElseToggle.click()
      }

      await waitForSidebarPreview(channelLink, previewMessage)
      await channelLink.click()
      await expect(userA.page).toHaveURL(new RegExp(`/w/${workspaceId}/s/${streamId}`), { timeout: 10000 })
      await expect(userA.page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({
        timeout: 10000,
      })
      await waitForStreamMessage(userA.page, previewMessage)

      // Verify channel is fully navigable/interactive without refresh by sending from User A.
      const followUpMessage = `User A follow-up ${Date.now()}`
      const userAEditor = userA.page.locator("[data-editor-zone='main'] [contenteditable='true']")
      await userAEditor.click()
      await userA.page.keyboard.type(followUpMessage)
      await expect(userAEditor).toContainText(followUpMessage, { timeout: 10000 })
      const userASendButton = userA.page.getByRole("button", { name: "Send" })
      await expect(userASendButton).toBeEnabled({ timeout: 10000 })
      await userASendButton.click()
      await waitForStreamMessage(userA.page, followUpMessage)
    } finally {
      await userA.context.close()
      if (userB) {
        await userB.context.close()
      }
    }
  })
})
