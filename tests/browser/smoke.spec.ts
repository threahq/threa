import { test, expect, type Locator, type Page } from "@playwright/test"
import { postMessage } from "./account-fixtures"
import {
  clickReplyInThread,
  createChannel,
  createChannelViaApi,
  expectApiOk,
  getActivePanel,
  joinWorkspace,
  loginAndCreateWorkspace,
  loginAndCreateWorkspaceViaApi,
  loginInNewContext,
  sendPanelReply,
  setAllSidebarPreset,
  waitForRealThreadPanel,
  workspaceIdFromUrl,
} from "./helpers"

/**
 * The happy-path smoke every pull request runs against the real stack: one
 * journey per core surface, each in its own workspace.
 */

// 1x1 red PNG
const TEST_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

const composer = (page: Page): Locator => page.locator("[data-message-composer-root] [contenteditable='true']").first()

const timelineMessage = (scope: Locator, text: string): Locator =>
  scope.locator(".message-item").filter({ hasText: text }).first()

async function openChannelBySlug(page: Page, workspaceId: string, channelId: string, slug: string): Promise<void> {
  await page.goto(`/w/${workspaceId}/s/${channelId}`)
  await expect(page.getByRole("heading", { name: `#${slug}`, level: 1 })).toBeVisible({ timeout: 15_000 })
}

async function openNewChannel(page: Page, workspaceId: string, slug: string): Promise<string> {
  const channelId = await createChannelViaApi(page, workspaceId, slug, "public")
  await openChannelBySlug(page, workspaceId, channelId, slug)
  return channelId
}

async function sendFromComposer(page: Page, text: string): Promise<void> {
  const editor = composer(page)
  await editor.click()
  await editor.pressSequentially(text)
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
  await expect(timelineMessage(page.getByRole("main"), text)).toBeVisible({ timeout: 10_000 })
}

async function pasteFile(editor: Locator, name: string, bytes: Buffer): Promise<void> {
  await editor.evaluate(
    (element, file) => {
      const clipboardData = new DataTransfer()
      clipboardData.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: "image/png" }))
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
    },
    { name, bytes: Array.from(bytes) }
  )
}

async function serverUnreadCount(page: Page, workspaceId: string, streamId: string): Promise<number> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(response, "Workspace bootstrap")
  const body = (await response.json()) as { data: { unreadCounts: Record<string, number> } }
  const count = body.data.unreadCounts[streamId]
  if (count === undefined) throw new Error(`Bootstrap unreadCounts has no entry for ${streamId}`)
  return count
}

test.describe("Smoke", () => {
  test("should keep a sent channel message across a reload", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "smoke-send")
    await createChannel(page, `smoke-${testId}`, { switchToAll: false })

    const message = `Persisted ${testId}`
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/messages") &&
        (response.request().postData() ?? "").includes(message)
    )
    await sendFromComposer(page, message)
    expect((await saved).status()).toBe(201)

    await page.reload()
    await expect(timelineMessage(page.getByRole("main"), message)).toBeVisible({ timeout: 15_000 })
  })

  test("should deliver a message live to another member and clear their unread on open", async ({ page, browser }) => {
    const { testId, workspaceId } = await loginAndCreateWorkspaceViaApi(page, "smoke-live")
    const lobbySlug = `lobby-${testId}`
    const lobbyId = await createChannelViaApi(page, workspaceId, lobbySlug, "public")
    const slug = `live-${testId}`
    const channelId = await createChannelViaApi(page, workspaceId, slug, "public")

    const reader = await joinWorkspace(browser, workspaceId, "smoke-reader", testId)
    try {
      for (const streamId of [lobbyId, channelId]) {
        await expectApiOk(
          await reader.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
          "Reader joins a channel"
        )
      }
      await setAllSidebarPreset(reader.page, workspaceId)
      await openChannelBySlug(reader.page, workspaceId, lobbyId, lobbySlug)

      const greeting = `Hello lobby ${testId}`
      await postMessage(page, workspaceId, lobbyId, greeting)
      await expect(timelineMessage(reader.page.getByRole("main"), greeting)).toBeVisible({ timeout: 15_000 })

      const row = reader.page
        .getByRole("navigation", { name: "Sidebar navigation" })
        .locator(`a[href*="/s/${channelId}"]`)
      // A channel row's only unread signal is its title weight; there is no badge or aria state.
      const rowTitle = row.getByText(`#${slug}`, { exact: true })
      await expect(rowTitle).toHaveClass(/font-medium/, { timeout: 10_000 })

      const message = `Live ${testId}`
      await postMessage(page, workspaceId, channelId, message)
      await expect(rowTitle).toHaveClass(/font-semibold/, { timeout: 15_000 })
      await expect.poll(() => serverUnreadCount(reader.page, workspaceId, channelId), { timeout: 15_000 }).toBe(1)

      await row.click()
      await expect(timelineMessage(reader.page.getByRole("main"), message)).toBeVisible({ timeout: 10_000 })
      await expect(rowTitle).toHaveClass(/font-medium/, { timeout: 15_000 })
      await expect.poll(() => serverUnreadCount(reader.page, workspaceId, channelId), { timeout: 15_000 }).toBe(0)
    } finally {
      await reader.context.close()
    }
  })

  test("should show the reply count on a thread's parent", async ({ page }) => {
    const { testId, workspaceId } = await loginAndCreateWorkspaceViaApi(page, "smoke-thread")
    const channelId = await openNewChannel(page, workspaceId, `thread-${testId}`)

    const parent = `Parent ${testId}`
    await sendFromComposer(page, parent)
    await clickReplyInThread(timelineMessage(page.getByRole("main"), parent))
    const reply = `Reply ${testId}`
    await sendPanelReply(page, reply)
    await waitForRealThreadPanel(page)
    await expect(getActivePanel(page).getByText(reply)).toBeVisible({ timeout: 10_000 })

    const parentInChannel = timelineMessage(page.locator(`[data-panel-tab="${channelId}"]`), parent)
    await expect(parentInChannel.getByRole("link", { name: /1 reply/i })).toBeVisible({ timeout: 15_000 })
  })

  test("should render a pasted image from storage", async ({ page }) => {
    const { testId, workspaceId } = await loginAndCreateWorkspaceViaApi(page, "smoke-image")
    await openNewChannel(page, workspaceId, `image-${testId}`)

    const text = `Image ${testId}`
    const editor = composer(page)
    await editor.click()
    await editor.pressSequentially(text)
    await pasteFile(editor, "photo.png", TEST_PNG)
    await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10_000 })
    await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
    await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(0, { timeout: 15_000 })

    const image = timelineMessage(page.getByRole("main"), text).locator("img[src*='/content?variant=thumbnail']")
    await expect(image).toBeAttached({ timeout: 15_000 })
    const src = await image.getAttribute("src")
    const raw = await page.request.get(src!.replace("?variant=thumbnail", ""))
    await expectApiOk(raw, "Fetch attachment content")
    expect(Buffer.compare(await raw.body(), TEST_PNG)).toBe(0)
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth), { timeout: 20_000 }).toBe(1)
  })

  test("should answer a persona mention in a thread with a session trace", async ({ page }) => {
    const { testId, workspaceId } = await loginAndCreateWorkspaceViaApi(page, "smoke-agent")
    await openNewChannel(page, workspaceId, `agent-${testId}`)

    const editor = composer(page)
    await editor.click()
    await editor.pressSequentially("@ariadne")
    await expect(page.getByRole("option")).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press("Enter")
    await expect(editor.locator('span[data-type="mention"][data-slug="ariadne"]')).toBeVisible()
    const ask = `help me out ${testId}`
    await editor.pressSequentially(` ${ask}`)
    await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()

    const replies = timelineMessage(page.getByRole("main"), ask).getByRole("link", { name: /1 reply/i })
    await expect(replies).toBeVisible({ timeout: 30_000 })
    await replies.click()

    const panel = getActivePanel(page)
    await expect(panel.getByText("stub response from the companion")).toBeVisible({ timeout: 15_000 })
    const sessionCard = panel.locator("a").filter({ hasText: "Session complete" })
    await expect(sessionCard).toBeVisible({ timeout: 15_000 })
    await sessionCard.click()
    await expect(page).toHaveURL(/trace=/)
  })

  test("should land an invited user in the workspace after accepting", async ({ page, browser }) => {
    const { testId, workspaceId, workspaceName } = await loginAndCreateWorkspaceViaApi(page, "smoke-inviter")
    const inviteeEmail = `smoke-invitee-${testId}@example.com`
    const inviteeName = `Invitee ${testId}`
    await expectApiOk(
      await page.request.post(`/api/workspaces/${workspaceId}/invitations`, {
        data: { emails: [inviteeEmail], role: "member" },
      }),
      "Send invitation"
    )

    const invitee = await loginInNewContext(browser, inviteeEmail, inviteeName)
    try {
      await expect
        .poll(
          async () => {
            const response = await invitee.page.request.get("/api/workspaces")
            if (!response.ok()) return false
            const body = (await response.json()) as { pendingInvitations?: Array<{ workspaceId: string }> }
            return body.pendingInvitations?.some((invite) => invite.workspaceId === workspaceId) ?? false
          },
          { message: "Invitation never reached the control plane", timeout: 20_000, intervals: [200, 500, 1000] }
        )
        .toBe(true)

      await invitee.page.goto("/workspaces")
      await expect(invitee.page.getByText(workspaceName)).toBeVisible({ timeout: 10_000 })
      await invitee.page.getByRole("button", { name: "Accept" }).click()
      await invitee.page.waitForURL(`**/w/${workspaceId}/setup`, { timeout: 15_000 })

      const displayName = invitee.page.getByLabel("Display name")
      await expect(displayName).toBeVisible({ timeout: 10_000 })
      await displayName.fill(inviteeName)
      const completeSetup = invitee.page.getByRole("button", { name: "Complete Setup" })
      await expect(completeSetup).toBeEnabled({ timeout: 10_000 })
      await completeSetup.click()

      await invitee.page.waitForURL(
        (url) => url.pathname.startsWith(`/w/${workspaceId}`) && !url.pathname.endsWith("/setup")
      )
      expect(workspaceIdFromUrl(invitee.page)).toBe(workspaceId)
      await expect(invitee.page.getByText(workspaceName)).toBeVisible({ timeout: 10_000 })
    } finally {
      await invitee.context.close()
    }
  })
})
