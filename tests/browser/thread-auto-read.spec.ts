import { test, expect, type Page, type Browser } from "@playwright/test"
import {
  clickReplyInThread,
  createChannel,
  expectApiOk,
  loginAndCreateWorkspace,
  loginInNewContext,
  sendPanelReply,
} from "./helpers"

/**
 * Auto-read in THREADS reaches the server. Ground truth is the workspace
 * bootstrap's unreadCounts for the thread stream (server-derived from
 * stream_read_state), never the badge.
 *
 * The agent cases are the regression shape: the viewer's watermark is the
 * born-read, hidden `member_added` event (seq 1), the reply is bracketed by
 * agent-session events that render no row, and the thread's rows reached the
 * cache through live sync before the thread was ever opened. A human reply
 * puts the watermark on the owner's own rendered message and passed
 * throughout; it stays as the control.
 */

test.describe.configure({ timeout: 120_000 })

const AGENT_COMPLETION_TIMEOUT = 30_000

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) throw new Error(`Could not extract IDs from URL: ${url}`)
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

async function serverUnreadCount(page: Page, workspaceId: string, streamId: string): Promise<number> {
  const res = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(res, "Workspace bootstrap")
  const body = (await res.json()) as { data?: { unreadCounts?: Record<string, number> } }
  const counts = body.data?.unreadCounts
  if (!counts) throw new Error(`Bootstrap response missing unreadCounts; keys: ${Object.keys(body).join(",")}`)
  return counts[streamId] ?? 0
}

async function serverThreadEventTypes(page: Page, workspaceId: string, streamId: string): Promise<string[]> {
  const res = await page.request.get(`/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`)
  await expectApiOk(res, "Stream bootstrap")
  const body = (await res.json()) as { data: { events: Array<{ eventType: string }> } }
  return body.data.events.map((e) => e.eventType)
}

async function sendMention(page: Page, message: string) {
  const editor = page.locator("[contenteditable='true']")
  await editor.click()
  await page.keyboard.type("@ariadne")
  await expect(page.getByRole("option")).toBeVisible({ timeout: 3000 })
  await page.keyboard.press("Enter")
  await expect(editor.locator('span[data-type="mention"][data-slug="ariadne"]')).toBeVisible()
  await page.keyboard.type(` ${message}`)
  await page.keyboard.press("Meta+Enter")
  await expect(page.getByRole("main").locator(".message-item").filter({ hasText: message }).first()).toBeVisible({
    timeout: 5000,
  })
}

async function waitForThreadId(page: Page, workspaceId: string, streamId: string, messageText: string) {
  const deadline = Date.now() + AGENT_COMPLETION_TIMEOUT
  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`)
    if (res.ok()) {
      const { data } = (await res.json()) as {
        data: {
          events: Array<{
            eventType: string
            payload?: { contentMarkdown?: string; threadId?: string; replyCount?: number }
          }>
        }
      }
      const trigger = data.events.find(
        (e) => e.eventType === "message_created" && e.payload?.contentMarkdown?.includes(messageText)
      )
      if (trigger?.payload?.threadId && (trigger.payload.replyCount ?? 0) > 0) return trigger.payload.threadId
    }
    await page.waitForTimeout(500)
  }
  throw new Error(`Timed out waiting for thread creation for message: ${messageText}`)
}

async function waitForSessionComplete(page: Page, workspaceId: string, threadId: string) {
  await expect
    .poll(() => serverThreadEventTypes(page, workspaceId, threadId), {
      timeout: AGENT_COMPLETION_TIMEOUT,
      message: "agent session should complete in the thread",
    })
    .toContain("agent_session:completed")
}

test.describe("Thread auto-read", () => {
  test("agent reply thread auto-reads when opened as a page", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "thread-autoread")
    await createChannel(page, `tar-page-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    await sendMention(page, `hi ${testId}`)
    const threadId = await waitForThreadId(page, workspaceId, streamId, `hi ${testId}`)
    await waitForSessionComplete(page, workspaceId, threadId)
    await page.goto(`/w/${workspaceId}/drafts`)
    expect(await serverUnreadCount(page, workspaceId, threadId)).toBe(1)

    await page.goto(`/w/${workspaceId}/s/${threadId}`)
    await expect(page.getByRole("main").getByText("stub response from the companion")).toBeVisible({ timeout: 10000 })
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, threadId), {
        timeout: 15000,
        message: "thread should auto-read",
      })
      .toBe(0)
  })

  test("agent reply thread auto-reads when opened in the panel", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "thread-autoread")
    await createChannel(page, `tar-panel-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    await sendMention(page, `hi ${testId}`)
    const threadId = await waitForThreadId(page, workspaceId, streamId, `hi ${testId}`)
    await waitForSessionComplete(page, workspaceId, threadId)
    await page.goto(`/w/${workspaceId}/drafts`)
    expect(await serverUnreadCount(page, workspaceId, threadId)).toBe(1)

    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)
    await expect(page.getByTestId("panel").getByText("stub response from the companion")).toBeVisible({
      timeout: 10000,
    })
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, threadId), {
        timeout: 15000,
        message: "thread should auto-read",
      })
      .toBe(0)
  })

  test("human reply thread auto-reads when opened as a page", async ({ page, browser }) => {
    const { testId } = await loginAndCreateWorkspace(page, "thread-autoread")
    await createChannel(page, `tar-human-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    await page.keyboard.type(`parent ${testId}`)
    await page.keyboard.press("Meta+Enter")
    const row = page
      .getByRole("main")
      .locator(".message-item")
      .filter({ hasText: `parent ${testId}` })
      .first()
    await expect(row).toBeVisible({ timeout: 5000 })
    await clickReplyInThread(row)
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 3000 })
    await sendPanelReply(page, `owner reply ${testId}`)
    await expect(page.getByTestId("panel").getByText(`owner reply ${testId}`)).toBeVisible({ timeout: 10000 })
    const threadId = await waitForThreadId(page, workspaceId, streamId, `parent ${testId}`)
    await page.goto(`/w/${workspaceId}/drafts`)

    const other = await loginInNewContext(browser, `tar-b-${testId}@example.com`, `TAR B ${testId}`)
    await expectApiOk(
      await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member", name: `TAR B ${testId}` },
      }),
      "join workspace"
    )
    await expectApiOk(
      await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
      "join channel"
    )
    await expect
      .poll(
        async () =>
          (
            await other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
              data: { streamId: threadId, content: `other reply ${testId}` },
            })
          ).status(),
        { timeout: 10000 }
      )
      .toBe(201)
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, threadId), { timeout: 10000 })
      .toBeGreaterThanOrEqual(1)

    await page.goto(`/w/${workspaceId}/s/${threadId}`)
    await expect(page.getByRole("main").getByText(`other reply ${testId}`)).toBeVisible({ timeout: 10000 })
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, threadId), {
        timeout: 15000,
        message: "thread should auto-read",
      })
      .toBe(0)
  })
})
