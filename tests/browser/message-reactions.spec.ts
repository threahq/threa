import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace, loginInNewContext, waitForWorkspaceProvisioned } from "./helpers"

/**
 * Message reaction E2E tests.
 *
 * Tests:
 * 1. Add a reaction via the emoji picker in the message toolbar
 * 2. Reaction pill appears below the message with count
 * 3. Toggle reaction off by clicking the pill
 * 4. Multi-user: User B sees User A's reaction in real-time via socket
 * 5. Emoji picker search filters results
 */

const SEARCH_EMOJI_PLACEHOLDER = "Search emoji..."

function getTimelineMessage(page: Page, messageText: string) {
  return page.getByRole("main").locator(".message-item").filter({ hasText: messageText }).first()
}

function getReactionSearchInput(page: Page) {
  return page.getByPlaceholder(SEARCH_EMOJI_PLACEHOLDER).last()
}

function getWorkspaceIdFromUrl(page: Page) {
  const match = page.url().match(/\/w\/([^/?]+)/)
  if (!match) {
    throw new Error(`Could not determine workspace ID from URL: ${page.url()}`)
  }
  return match[1]
}

async function waitForTimelineMessage(page: Page, messageText: string, timeout = 10000) {
  const message = getTimelineMessage(page, messageText)
  await expect(message).toBeVisible({ timeout })
  return message
}

async function openReactionPicker(page: Page, messageContainer: ReturnType<typeof getTimelineMessage>) {
  const searchInput = getReactionSearchInput(page)

  for (let attempt = 0; attempt < 3; attempt++) {
    await messageContainer.hover()

    const reactionButton = messageContainer.getByRole("button", { name: "Add reaction" }).first()
    await expect(reactionButton).toBeVisible({ timeout: 5000 })
    await reactionButton.click()

    try {
      await expect(searchInput).toBeVisible({ timeout: 3000 })
      return searchInput
    } catch (error) {
      await page.keyboard.press("Escape").catch(() => {})
      if (attempt === 2) {
        throw error
      }
    }
  }

  throw new Error("Failed to open reaction picker")
}

async function fillReactionSearch(page: Page, messageContainer: ReturnType<typeof getTimelineMessage>, value: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const searchInput = await openReactionPicker(page, messageContainer)

    try {
      await searchInput.fill(value)
      return searchInput
    } catch (error) {
      await page.keyboard.press("Escape").catch(() => {})
      if (attempt === 2) {
        throw error
      }
    }
  }

  throw new Error(`Failed to fill reaction search with "${value}"`)
}

async function waitForEmojiGrid(page: Page) {
  const listbox = page.locator("[role='listbox']").last()
  await expect(listbox).toBeVisible({ timeout: 5000 })

  const emojiButtons = listbox.locator("button[role='option']")
  await expect.poll(async () => emojiButtons.count(), { timeout: 5000 }).toBeGreaterThan(0)
  await expect(emojiButtons.first()).toBeVisible({ timeout: 5000 })

  return { listbox, emojiButtons }
}

async function openReactionPickerGrid(page: Page, messageContainer: ReturnType<typeof getTimelineMessage>) {
  const searchInput = getReactionSearchInput(page)

  for (let attempt = 0; attempt < 3; attempt++) {
    const pickerIsOpen = await searchInput.isVisible().catch(() => false)
    if (!pickerIsOpen) {
      await openReactionPicker(page, messageContainer)
    }

    try {
      const { listbox, emojiButtons } = await waitForEmojiGrid(page)
      return { searchInput, listbox, emojiButtons }
    } catch (error) {
      await page.keyboard.press("Escape").catch(() => {})
      if (attempt === 2) {
        throw error
      }
    }
  }

  throw new Error("Failed to open reaction picker grid")
}

async function setupSingleUserReactionMessage(page: Page, prefix: string, messageText: string) {
  await loginAndCreateWorkspace(page, prefix)

  const workspaceId = getWorkspaceIdFromUrl(page)
  const channelName = `${prefix}-${Date.now().toString(36)}`

  const createStreamRes = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug: channelName, visibility: "public" },
  })
  await expectApiOk(createStreamRes, "Create reaction test channel")
  const { stream } = (await createStreamRes.json()) as { stream: { id: string } }

  const sendMessageRes = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId: stream.id, content: messageText },
  })
  await expectApiOk(sendMessageRes, "Create reaction test message")

  await page.goto(`/w/${workspaceId}/s/${stream.id}`)
  const messageContainer = await waitForTimelineMessage(page, messageText, 10000)

  return { workspaceId, streamId: stream.id, channelName, messageContainer }
}

test.describe("Message Reactions", () => {
  test("should add a reaction via toolbar emoji picker and display pill", async ({ page }) => {
    const testId = Date.now().toString(36)
    const messageText = `Reaction test ${testId}`
    const { messageContainer } = await setupSingleUserReactionMessage(page, "react", messageText)

    // Emoji picker popover should open with a visible grid
    const { emojiButtons } = await openReactionPickerGrid(page, messageContainer)

    // Click the first visible emoji result
    const emojiButton = emojiButtons.first()
    const emoji = (await emojiButton.textContent())?.trim()
    if (!emoji) {
      throw new Error("First emoji option rendered without visible emoji content")
    }
    await emojiButton.click()

    // Popover should close
    await expect(getReactionSearchInput(page)).not.toBeVisible()

    // Reaction pill should appear below the message with count "1"
    const reactionPill = messageContainer.locator("button").filter({ hasText: emoji }).first()
    await expect(reactionPill).toBeVisible({ timeout: 5000 })
    await expect(reactionPill).toContainText("1")
  })

  test("should toggle reaction off by clicking the pill", async ({ page }) => {
    const testId = Date.now().toString(36)
    const messageText = `Toggle test ${testId}`
    const { messageContainer } = await setupSingleUserReactionMessage(page, "toggle", messageText)

    // Add a reaction via toolbar
    const { emojiButtons } = await openReactionPickerGrid(page, messageContainer)
    const emojiButton = emojiButtons.first()
    const emoji = (await emojiButton.textContent())?.trim()
    if (!emoji) {
      throw new Error("First emoji option rendered without visible emoji content")
    }
    await emojiButton.click()

    // Wait for reaction pill to appear
    const reactionPill = messageContainer.locator("button").filter({ hasText: emoji }).first()
    await expect(reactionPill).toBeVisible({ timeout: 5000 })

    // Click the pill to toggle off
    await reactionPill.click()

    // Reaction pill should disappear (count drops to 0 → removed)
    await expect(reactionPill).not.toBeVisible({ timeout: 5000 })
  })

  test("should show reaction from another user in real-time", async ({ browser }) => {
    test.setTimeout(60000)

    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const userAEmail = `reactor-a-${testId}@example.com`
    const userAName = `Reactor A ${testId}`
    const userBEmail = `reactor-b-${testId}@example.com`
    const userBName = `Reactor B ${testId}`

    // User A: create workspace + channel via API
    const ctxA = await loginInNewContext(browser, userAEmail, userAName)
    let ctxB: { context: BrowserContext; page: Page } | undefined

    try {
      const createWsRes = await ctxA.page.request.post("/api/workspaces", {
        data: { name: `React Test ${testId}`, slug: `react-${testId}` },
      })
      expect(createWsRes.ok()).toBeTruthy()
      const { workspace } = (await createWsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctxA.page, workspaceId)

      const channelSlug = `reactions-${testId}`
      const createStreamRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      expect(createStreamRes.ok()).toBeTruthy()
      const { stream } = (await createStreamRes.json()) as { stream: { id: string } }
      const streamId = stream.id

      // User B: join workspace + channel, open in browser
      ctxB = await loginInNewContext(browser, userBEmail, userBName)
      const joinWsRes = await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member" },
      })
      expect(joinWsRes.ok()).toBeTruthy()

      const joinStreamRes = await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)
      expect(joinStreamRes.ok()).toBeTruthy()

      // User A: send a message via API
      const messageContent = `React this ${testId}`
      const sendRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: messageContent },
      })
      expect(sendRes.ok()).toBeTruthy()
      const { message } = (await sendRes.json()) as { message: { id: string } }

      // User B: open the channel in browser
      await ctxB.page.goto(`/w/${workspaceId}/s/${streamId}`)
      const messageContainer = await waitForTimelineMessage(ctxB.page, messageContent)

      // User A: add a reaction via API
      const reactRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/messages/${message.id}/reactions`, {
        data: { emoji: "👍" },
      })
      expect(reactRes.ok()).toBeTruthy()

      // User B: should see the reaction pill appear in real-time
      const reactionPill = messageContainer.locator("button").filter({ hasText: "👍" }).first()
      await expect(reactionPill).toBeVisible({ timeout: 10000 })
      await expect(reactionPill).toContainText("1")
    } finally {
      await ctxA.context.close()
      await ctxB?.context.close()
    }
  })

  test("reaction from another user should not trigger unread divider", async ({ browser }) => {
    test.setTimeout(60000)

    const testId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const userAEmail = `unread-a-${testId}@example.com`
    const userAName = `Unread A ${testId}`
    const userBEmail = `unread-b-${testId}@example.com`
    const userBName = `Unread B ${testId}`

    const ctxA = await loginInNewContext(browser, userAEmail, userAName)
    let ctxB: { context: BrowserContext; page: Page } | undefined

    try {
      // User A: create workspace + channel
      const createWsRes = await ctxA.page.request.post("/api/workspaces", {
        data: { name: `Unread Test ${testId}`, slug: `unread-${testId}` },
      })
      expect(createWsRes.ok()).toBeTruthy()
      const { workspace } = (await createWsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctxA.page, workspaceId)

      const channelSlug = `unread-react-${testId}`
      const createStreamRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      expect(createStreamRes.ok()).toBeTruthy()
      const { stream } = (await createStreamRes.json()) as { stream: { id: string } }
      const streamId = stream.id

      // User B: join workspace + channel
      ctxB = await loginInNewContext(browser, userBEmail, userBName)
      const joinWsRes = await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member" },
      })
      expect(joinWsRes.ok()).toBeTruthy()
      const joinStreamRes = await ctxB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)
      expect(joinStreamRes.ok()).toBeTruthy()

      // User A: send a message
      const messageContent = `Unread divider test ${testId}`
      const sendRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: messageContent },
      })
      expect(sendRes.ok()).toBeTruthy()
      const { message } = (await sendRes.json()) as { message: { id: string } }

      // User B: open the channel and let the *client* mark it read. The read
      // must go through the app (which updates client-side read state), not a
      // raw API call — a server-only read leaves the client convinced the
      // message is still unread, so it shows its own divider. Wait for the
      // app's own read POST to confirm the client caught up.
      const clientReadLanded = ctxB.page.waitForResponse(
        (res) => res.url().includes(`/streams/${streamId}/read`) && res.request().method() === "POST" && res.ok(),
        { timeout: 15000 }
      )
      await ctxB.page.goto(`/w/${workspaceId}/s/${streamId}`)
      const timelineMessage = ctxB.page
        .getByRole("main")
        .locator(".message-item")
        .filter({ hasText: messageContent })
        .first()
      await expect(timelineMessage).toBeVisible({ timeout: 10000 })
      await clientReadLanded

      // User B: navigate away from the stream
      await ctxB.page.goto(`/w/${workspaceId}`)
      await ctxB.page.waitForURL(`**/w/${workspaceId}`, { timeout: 10000 })

      // User A: add a reaction to the message while User B is away
      const reactRes = await ctxA.page.request.post(`/api/workspaces/${workspaceId}/messages/${message.id}/reactions`, {
        data: { emoji: "👍" },
      })
      expect(reactRes.ok()).toBeTruthy()

      // User B: navigate back to the channel
      await ctxB.page.goto(`/w/${workspaceId}/s/${streamId}`)
      await expect(timelineMessage).toBeVisible({ timeout: 10000 })

      // The "New" unread divider must NOT appear: the message was already read
      // client-side, and a reaction is an invisible event that never anchors the
      // divider. (The divider now persists for the session, so this asserts it
      // genuinely never showed — not that it auto-dismissed.)
      const unreadDivider = ctxB.page.getByRole("main").getByText("New", { exact: true })
      await expect(unreadDivider).not.toBeVisible({ timeout: 3000 })

      // The reaction should be visible
      const messageContainer = ctxB.page.getByRole("main").locator(".group").filter({ hasText: messageContent }).first()
      await expect(messageContainer.locator("button").filter({ hasText: "👍" }).first()).toBeVisible({ timeout: 10000 })
    } finally {
      await ctxA.context.close()
      await ctxB?.context.close()
    }
  })

  test("should filter emojis in reaction picker search", async ({ page }) => {
    const testId = Date.now().toString(36)
    const messageText = `Search test ${testId}`
    const { messageContainer } = await setupSingleUserReactionMessage(page, "search", messageText)

    // Open reaction picker
    await openReactionPicker(page, messageContainer)

    // Search for a nonsense query — should show "No emojis found"
    await fillReactionSearch(page, messageContainer, "xyznonexistent")
    await expect(page.getByText("No emojis found")).toBeVisible({ timeout: 5000 })

    // Clear and search for "thumbsup" — should show matching emoji
    await fillReactionSearch(page, messageContainer, "thumbsup")
    await waitForEmojiGrid(page)
    const thumbsButton = page.locator("[role='listbox'] button[aria-label=':+1:']").last()
    await expect(thumbsButton).toBeVisible({ timeout: 5000 })
  })

  test("should render emoji grid with visible emojis on open", async ({ page }) => {
    const testId = Date.now().toString(36)
    const messageText = `Grid test ${testId}`
    const { messageContainer } = await setupSingleUserReactionMessage(page, "grid", messageText)

    // Open reaction picker and wait for the grid to stabilize.
    const { searchInput, emojiButtons } = await openReactionPickerGrid(page, messageContainer)

    await expect(searchInput).toBeFocused()

    // First emoji should be selected by default
    await expect(emojiButtons.first()).toHaveAttribute("data-selected", "true")

    // Footer should show the selected emoji shortcode
    const footer = page.locator(".border-t .font-mono")
    await expect(footer).toBeVisible()
  })

  test("should navigate emoji grid with arrow keys and select with Enter", async ({ page }) => {
    const testId = Date.now().toString(36)
    const messageText = `Keynav test ${testId}`
    const { messageContainer } = await setupSingleUserReactionMessage(page, "keynav", messageText)

    // Open reaction picker and wait for the grid to render
    const { emojiButtons } = await openReactionPickerGrid(page, messageContainer)
    const searchInput = getReactionSearchInput(page)
    await expect(searchInput).toBeVisible({ timeout: 5000 })

    // First item should be selected
    await expect(emojiButtons.first()).toHaveAttribute("data-selected", "true")

    // Press ArrowRight to move to second item
    await page.keyboard.press("ArrowRight")
    await expect(emojiButtons.nth(1)).toHaveAttribute("data-selected", "true")
    await expect(emojiButtons.first()).not.toHaveAttribute("data-selected", "true")

    // Press ArrowLeft to go back
    await page.keyboard.press("ArrowLeft")
    await expect(emojiButtons.first()).toHaveAttribute("data-selected", "true")

    // Type a search query — characters should go into search input
    await page.keyboard.type("rocket")
    await expect(searchInput).toHaveValue("rocket")

    // Press Enter to select the first filtered result
    await page.keyboard.press("Enter")

    // Popover should close and reaction pill should appear
    await expect(searchInput).not.toBeVisible()
    await expect(messageContainer.getByText("🚀")).toBeVisible({ timeout: 5000 })
  })

  test("should close emoji picker with Escape", async ({ page }) => {
    const testId = Date.now().toString(36)
    const messageText = `Escape test ${testId}`
    const { messageContainer } = await setupSingleUserReactionMessage(page, "esc", messageText)

    // Open reaction picker
    const searchInput = await openReactionPicker(page, messageContainer)

    // Press Escape
    await page.keyboard.press("Escape")

    // Popover should close
    await expect(searchInput).not.toBeVisible()
  })

  test("should show inline + button to add more reactions when reactions exist", async ({ page }) => {
    const testId = Date.now().toString(36)
    const messageText = `Inline add ${testId}`
    const { messageContainer } = await setupSingleUserReactionMessage(page, "inline", messageText)

    // Add first reaction via toolbar
    await fillReactionSearch(page, messageContainer, "fire")
    await waitForEmojiGrid(page)
    const fireButton = page.locator("[role='listbox'] button[aria-label=':fire:']").last()
    await expect(fireButton).toBeVisible({ timeout: 5000 })
    await fireButton.click()

    // Wait for reaction pill
    await expect(messageContainer.getByText("🔥")).toBeVisible({ timeout: 5000 })

    // The inline "Add reaction" + button should also appear next to the pills
    const inlineAddButtons = messageContainer.getByRole("button", { name: "Add reaction" })
    // Should have at least the inline one (toolbar one may be hidden since we're not hovering)
    await expect(inlineAddButtons.first()).toBeVisible({ timeout: 5000 })
  })
})
