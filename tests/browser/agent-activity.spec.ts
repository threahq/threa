import { test, expect } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * Tests for agent activity indicator and session card behavior.
 *
 * When a user @mentions a persona in a channel:
 * 1. Agent creates a thread and runs there
 * 2. Session card (started/completed) appears in the thread, NOT the channel
 * 3. Agent response appears in the thread
 *
 * With USE_STUB_COMPANION=true, the agent sends a canned response
 * but the full session lifecycle (create → complete) still fires.
 */

// Stub companion is fast but session lifecycle (create → complete) involves
// multiple async hops (outbox → broadcast → UI). 15s accommodates CI slowness.
const AGENT_COMPLETION_TIMEOUT = 30_000

test.describe("Agent Activity", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "agent-activity")
  })

  function getWorkspaceAndStreamIds(page: import("@playwright/test").Page) {
    const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
    if (!match) {
      throw new Error(`Could not determine workspace/stream from URL: ${page.url()}`)
    }
    return { workspaceId: match[1], streamId: match[2] }
  }

  async function waitForThreadId(page: import("@playwright/test").Page, messageText: string) {
    const { workspaceId, streamId } = getWorkspaceAndStreamIds(page)
    const deadline = Date.now() + AGENT_COMPLETION_TIMEOUT

    while (Date.now() < deadline) {
      const bootstrapRes = await page.request.get(`/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`)
      if (bootstrapRes.ok()) {
        const { data } = (await bootstrapRes.json()) as {
          data: {
            events: Array<{
              eventType: string
              payload?: {
                contentMarkdown?: string
                threadId?: string
                replyCount?: number
              }
            }>
          }
        }

        const triggerEvent = data.events.find(
          (event) => event.eventType === "message_created" && event.payload?.contentMarkdown?.includes(messageText)
        )

        if (triggerEvent?.payload?.threadId && (triggerEvent.payload.replyCount ?? 0) > 0) {
          return { workspaceId, streamId, threadId: triggerEvent.payload.threadId }
        }
      }

      await page.waitForTimeout(500)
    }

    throw new Error(`Timed out waiting for thread creation for message: ${messageText}`)
  }

  /** Send an @ariadne mention in the current channel editor */
  async function sendMention(page: import("@playwright/test").Page, message: string) {
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

  /** Wait for agent to create the thread and open it directly */
  async function waitForAgentAndOpenThread(page: import("@playwright/test").Page, messageText: string) {
    const { workspaceId, streamId, threadId } = await waitForThreadId(page, messageText)
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)

    // Wait for thread panel to load with content (not just the empty "Start a new thread" state).
    // Scope to the panel: the channel timeline also renders a truncated reply preview with the
    // same text, so an unscoped getByText hits a strict-mode violation once that preview renders.
    await expect(page.getByTestId("panel").getByText("stub response from the companion")).toBeVisible({
      timeout: 10000,
    })
  }

  test("should show agent response in thread after @mention in channel", async ({ page }) => {
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const channelName = `agent-resp-${testId}`
    await createChannel(page, channelName)

    await sendMention(page, "help me out")
    await waitForAgentAndOpenThread(page, "help me out")

    // Thread shows the agent persona name (Ariadne) as the message author
    await expect(page.getByText("Ariadne").last()).toBeVisible({ timeout: 3000 })
  })

  test("should show session card in thread, not in channel", async ({ page }) => {
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const channelName = `sess-card-${testId}`
    await createChannel(page, channelName)

    await sendMention(page, "do your thing")

    // Wait for agent to complete
    const { workspaceId, streamId, threadId } = await waitForThreadId(page, "do your thing")

    // Session card should NOT be visible in the channel view
    await expect(page.getByText("Session complete")).not.toBeVisible({ timeout: 2000 })

    // Open thread
    await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)

    // Session card SHOULD be visible in the thread
    await expect(page.getByText("Session complete")).toBeVisible({ timeout: 10000 })
  })

  test("should show session card with subtitle (no layout shift)", async ({ page }) => {
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const channelName = `layout-${testId}`
    await createChannel(page, channelName)

    await sendMention(page, "check this")
    await waitForAgentAndOpenThread(page, "check this")

    // Session card should be a link with completion info
    const sessionCard = page.locator("a").filter({ hasText: "Session complete" })
    await expect(sessionCard).toBeVisible({ timeout: 10000 })

    // The subtitle should show step count + duration + message count.
    // This verifies the subtitle row is always rendered (not conditionally hidden),
    // preventing layout shift when transitioning from running → completed.
    await expect(sessionCard.getByText(/step/i)).toBeVisible()
    await expect(sessionCard.getByText(/message/i)).toBeVisible()
  })

  test("should link session card to trace view", async ({ page }) => {
    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const channelName = `trace-${testId}`
    await createChannel(page, channelName)

    await sendMention(page, "show me trace")
    await waitForAgentAndOpenThread(page, "show me trace")

    // Session card should be a link containing trace URL
    const sessionCard = page.locator("a").filter({ hasText: "Session complete" })
    await expect(sessionCard).toBeVisible({ timeout: 10000 })

    const href = await sessionCard.getAttribute("href")
    expect(href).toContain("trace=")
  })
})
