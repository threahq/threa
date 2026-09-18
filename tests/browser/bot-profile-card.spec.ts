import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

test.describe("Bot profile card", () => {
  test("clicking a bot's name opens its card, and Manage lands on its settings", async ({ page }) => {
    test.setTimeout(60000)

    const { testId } = await loginAndCreateWorkspace(page, "bot-card")
    const channelName = `bot-card-${testId}`
    await createChannel(page, channelName)
    const workspaceId = page.url().match(/\/w\/(ws_[^/]+)/)![1]

    const botName = `Card Bot ${testId}`
    const createBotRes = await page.request.post(`/api/workspaces/${workspaceId}/bots`, {
      data: { name: botName, slug: `card-bot-${testId}`, description: "Answers deploy questions" },
    })
    expect(createBotRes.ok()).toBe(true)
    const botId = ((await createBotRes.json()) as { data: { id: string } }).data.id

    const keyRes = await page.request.post(`/api/workspaces/${workspaceId}/bots/${botId}/keys`, {
      data: { name: `card-key-${testId}`, scopes: ["messages:write", "streams:read", "bot-runtime:write"] },
    })
    expect(keyRes.ok()).toBe(true)
    const keyValue = ((await keyRes.json()) as { value: string }).value

    const streamsRes = await page.request.get(`/api/v1/workspaces/${workspaceId}/streams`, {
      headers: { Authorization: `Bearer ${keyValue}` },
    })
    const streamId = ((await streamsRes.json()) as { data: Array<{ id: string; slug: string | null }> }).data.find(
      (s) => s.slug === channelName
    )!.id

    expect(
      (await page.request.post(`/api/workspaces/${workspaceId}/bots/${botId}/streams/${streamId}/grant`)).ok()
    ).toBe(true)
    expect(
      (
        await page.request.post(`/api/v1/workspaces/${workspaceId}/bot-runtime/presence`, {
          headers: { Authorization: `Bearer ${keyValue}` },
          data: {
            runtimeKind: "hermes",
            instanceId: `card-runtime-${testId}`,
            status: "available",
            acceptingInvocations: true,
          },
        })
      ).ok()
    ).toBe(true)
    const messageContent = `Hello from the card bot ${testId}`
    expect(
      (
        await page.request.post(`/api/v1/workspaces/${workspaceId}/streams/${streamId}/messages`, {
          headers: { Authorization: `Bearer ${keyValue}` },
          data: { content: messageContent },
        })
      ).ok()
    ).toBe(true)

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.getByRole("paragraph").filter({ hasText: messageContent })).toBeVisible({ timeout: 10000 })

    await page.getByRole("button", { name: botName, exact: true }).first().click()

    const card = page.getByRole("dialog")
    await expect(card.getByRole("heading", { name: botName })).toBeVisible({ timeout: 10000 })
    await expect(card.getByText("Shared", { exact: true })).toBeVisible()
    await expect(card.getByText("Answers deploy questions")).toBeVisible()
    await expect(card.getByText("Reads only the streams it's added to")).toBeVisible()
    await expect(card.getByText(/Available · Hermes · seen/)).toBeVisible()
    await expect(card.getByRole("list", { name: "Streams" }).getByRole("link")).toHaveText([`#${channelName}`])

    await card.getByRole("link", { name: "Manage" }).click()

    await expect(page).toHaveURL(new RegExp(`ws-settings=bots.*bot=${botId}|bot=${botId}.*ws-settings=bots`))
    const settings = page.getByRole("dialog")
    await expect(settings.getByRole("heading", { name: botName })).toBeVisible({ timeout: 10000 })
  })
})
