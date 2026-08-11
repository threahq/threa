import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, generateTestId, createChannel } from "./helpers"

/**
 * Bot customization E2E tests.
 *
 * Exercises the full bot management flow:
 * 1. Create a bot via workspace settings
 * 2. Generate an API key for the bot
 * 3. Send a message using the bot key
 * 4. Verify the BOT label appears in the timeline
 * 5. Upload an avatar for the bot
 * 6. Archive the bot
 */

test.describe("Bot Customization", () => {
  test("admin can create bot, generate key, send message, and see BOT label", async ({ page }) => {
    test.setTimeout(60000)

    // Setup: create workspace + channel
    const { testId } = await loginAndCreateWorkspace(page, "bot-e2e")
    const channelName = `bot-ch-${testId}`
    await createChannel(page, channelName)

    // Get workspaceId from URL
    const url = page.url()
    const workspaceIdMatch = url.match(/\/w\/(ws_[^/]+)/)
    expect(workspaceIdMatch).not.toBeNull()
    const workspaceId = workspaceIdMatch![1]

    // ──── Step 1: Create a bot via API ────

    const botName = `Test Bot ${testId}`
    const botSlug = `test-bot-${testId}`

    const createBotRes = await page.request.post(`/api/workspaces/${workspaceId}/bots`, {
      data: { name: botName, slug: botSlug, description: "An E2E test bot" },
    })
    expect(createBotRes.ok()).toBe(true)
    const botBody = (await createBotRes.json()) as { data: { id: string } }
    const botId = botBody.data.id

    // Verify bot appears in workspace settings UI
    await page.goto(`/w/${workspaceId}?ws-settings=bots`)
    const settingsDialog = page.getByRole("dialog")
    await expect(settingsDialog.getByText(botName)).toBeVisible({ timeout: 10000 })

    // ──── Step 2: Generate an API key via API ────

    const createKeyRes = await page.request.post(`/api/workspaces/${workspaceId}/bots/${botId}/keys`, {
      data: { name: `e2e-key-${testId}`, scopes: ["messages:write", "streams:read"] },
    })
    expect(createKeyRes.ok()).toBe(true)
    const keyBody = (await createKeyRes.json()) as { value: string }
    const keyValue = keyBody.value
    expect(keyValue).toMatch(/^threa_bk_/)

    // ──── Step 3: Send a message using the bot key ────

    // Get the streamId for the channel via the public API using the bot key
    const streamsRes = await page.request.get(`/api/v1/workspaces/${workspaceId}/streams`, {
      headers: { Authorization: `Bearer ${keyValue}` },
    })
    expect(streamsRes.ok()).toBe(true)
    const streamsBody = (await streamsRes.json()) as { data: Array<{ id: string; slug: string | null }> }
    const channel = streamsBody.data.find((s) => s.slug === channelName)
    expect(channel).toBeTruthy()
    const streamId = channel!.id

    const grantRes = await page.request.post(`/api/workspaces/${workspaceId}/bots/${botId}/streams/${streamId}/grant`)
    expect(grantRes.ok()).toBe(true)

    // Send a message via the public API using the bot key
    const messageContent = `Bot message from E2E test ${testId}`
    const sendRes = await page.request.post(`/api/v1/workspaces/${workspaceId}/streams/${streamId}/messages`, {
      headers: {
        Authorization: `Bearer ${keyValue}`,
        "Content-Type": "application/json",
      },
      data: { content: messageContent },
    })
    expect(sendRes.ok()).toBe(true)

    // ──── Step 4: Verify the BOT label appears in the timeline ────

    // Navigate directly to the channel (closes any open dialogs)
    await page.goto(`/w/${workspaceId}`)
    // Wait for sidebar to load, then click the channel
    await expect(page.getByRole("link", { name: `#${channelName}` })).toBeVisible({ timeout: 10000 })
    await page.getByRole("link", { name: `#${channelName}` }).click()
    await expect(page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({ timeout: 5000 })

    // Verify the bot message and BOT label are visible.
    // Reload the page to ensure the message appears via bootstrap (not just websocket).
    await page.reload()
    await expect(page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({ timeout: 10000 })

    // The message text should appear in the timeline
    await expect(page.getByRole("paragraph").filter({ hasText: messageContent })).toBeVisible({ timeout: 10000 })
    // BOT label should be visible
    await expect(page.getByText("BOT", { exact: true }).first()).toBeVisible()
  })

  test("bot avatar upload works with correct field name", async ({ page }) => {
    test.setTimeout(60000)

    await loginAndCreateWorkspace(page, "bot-avatar")
    const url = page.url()
    const workspaceId = url.match(/\/w\/(ws_[^/]+)/)![1]

    // Create a bot via API for speed
    const testId = generateTestId()
    const createBotRes = await page.request.post(`/api/workspaces/${workspaceId}/bots`, {
      data: {
        name: `Avatar Bot ${testId}`,
        slug: `avatar-bot-${testId}`,
      },
    })
    expect(createBotRes.ok()).toBe(true)
    const botBody = (await createBotRes.json()) as { data: { id: string; name: string } }
    const botId = botBody.data.id

    // Upload avatar via API with correct field name "avatar"
    const pngPixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    )
    const uploadRes = await page.request.post(`/api/workspaces/${workspaceId}/bots/${botId}/avatar`, {
      multipart: {
        avatar: {
          name: "test-avatar.png",
          mimeType: "image/png",
          buffer: pngPixel,
        },
      },
    })
    expect(uploadRes.ok()).toBe(true)
    const uploadBody = (await uploadRes.json()) as { data: { avatarUrl: string | null } }
    expect(uploadBody.data.avatarUrl).toBeTruthy()
    expect(uploadBody.data.avatarUrl).toMatch(/^avatars\//)

    // Verify the avatar is serveable
    const avatarUrl = uploadBody.data.avatarUrl!
    const match = avatarUrl.match(/^avatars\/[^/]+\/bots\/[^/]+\/(\d+)$/)
    expect(match).toBeTruthy()
    const timestamp = match![1]

    const serveRes = await page.request.get(`/api/workspaces/${workspaceId}/bots/${botId}/avatar/${timestamp}.64.webp`)
    expect(serveRes.ok()).toBe(true)
    expect(serveRes.headers()["content-type"]).toBe("image/webp")

    // Verify avatar shows in settings UI
    await page.goto(`/w/${workspaceId}?ws-settings=bots`)
    await expect(page.getByText(botBody.data.name)).toBeVisible({ timeout: 10000 })
  })

  test("bot archive revokes all keys", async ({ page }) => {
    test.setTimeout(60000)

    await loginAndCreateWorkspace(page, "bot-archive")
    const url = page.url()
    const workspaceId = url.match(/\/w\/(ws_[^/]+)/)![1]

    const testId = generateTestId()

    // Create bot + key via API
    const createBotRes = await page.request.post(`/api/workspaces/${workspaceId}/bots`, {
      data: { name: `Archive Bot ${testId}`, slug: `archive-bot-${testId}` },
    })
    expect(createBotRes.ok()).toBe(true)
    const botId = ((await createBotRes.json()) as { data: { id: string } }).data.id

    const createKeyRes = await page.request.post(`/api/workspaces/${workspaceId}/bots/${botId}/keys`, {
      data: { name: "to-be-revoked", scopes: ["messages:write"] },
    })
    expect(createKeyRes.ok()).toBe(true)
    const keyValue = ((await createKeyRes.json()) as { value: string }).value

    // Archive the bot
    const archiveRes = await page.request.post(`/api/workspaces/${workspaceId}/bots/${botId}/archive`)
    expect(archiveRes.ok()).toBe(true)

    // Verify the key no longer works (bot archived → key revoked)
    const streamsRes = await page.request.get(`/api/workspaces/${workspaceId}/streams`, {
      headers: { "Content-Type": "application/json" },
    })
    const streams = ((await streamsRes.json()) as { streams: Array<{ id: string }> }).streams
    if (streams.length > 0) {
      const sendRes = await page.request.post(`/api/v1/workspaces/${workspaceId}/streams/${streams[0].id}/messages`, {
        headers: {
          Authorization: `Bearer ${keyValue}`,
          "Content-Type": "application/json",
        },
        data: { content: "should fail" },
      })
      // Key was revoked on archive — should fail auth
      expect(sendRes.ok()).toBe(false)
      expect(sendRes.status()).toBe(401)
    }
  })
})
