import { expect, test } from "@playwright/test"
import {
  clickReplyInThread,
  expectApiOk,
  generateTestId,
  loginInNewContext,
  sendPanelReply,
  waitForRealThreadPanel,
  waitForWorkspaceProvisioned,
} from "./helpers"

async function createWorkspaceSession(page: import("@playwright/test").Page, prefix: string) {
  const testId = generateTestId()
  const email = `${prefix}-${testId}@example.com`
  const name = `${prefix} ${testId}`

  await expectApiOk(
    await page.request.post("/api/dev/login", {
      data: { email, name },
    }),
    "Stub auth login"
  )

  const response = await page.request.post("/api/workspaces", {
    data: { name: `${prefix} WS ${testId}` },
  })
  await expectApiOk(response, "Workspace creation")
  const body = (await response.json()) as { workspace?: { id?: string } }
  const workspaceId = body.workspace?.id
  if (!workspaceId) {
    throw new Error("Workspace creation response is missing workspace.id")
  }

  await waitForWorkspaceProvisioned(page, workspaceId)

  return { testId, workspaceId, email, name }
}

async function createChannel(
  page: import("@playwright/test").Page,
  workspaceId: string,
  slug: string,
  visibility: "public" | "private" = "public"
) {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: {
      type: "channel",
      slug,
      visibility,
    },
  })
  await expectApiOk(response, "Create public channel")
  const body = (await response.json()) as { stream: { id: string } }
  return body.stream.id
}

async function joinWorkspaceAndChannel(page: import("@playwright/test").Page, workspaceId: string, streamId: string) {
  await expectApiOk(
    await page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } }),
    "Join workspace"
  )
  await expectApiOk(await page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`), "Join channel")
}

async function addMemberToChannel(
  page: import("@playwright/test").Page,
  workspaceId: string,
  streamId: string,
  memberId: string
) {
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/members`, {
      data: { memberId },
    }),
    "Add channel member"
  )
}

async function removeMemberFromChannel(
  page: import("@playwright/test").Page,
  workspaceId: string,
  streamId: string,
  memberId: string
) {
  await expectApiOk(
    await page.request.delete(`/api/workspaces/${workspaceId}/streams/${streamId}/members/${memberId}`),
    "Remove channel member"
  )
}

async function sendMessageViaApi(
  page: import("@playwright/test").Page,
  workspaceId: string,
  streamId: string,
  content: string
) {
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: {
        streamId,
        content,
      },
    }),
    "Send message"
  )
}

async function getWorkspaceUserIdByEmail(page: import("@playwright/test").Page, workspaceId: string, email: string) {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(response, "Get workspace bootstrap")
  const body = (await response.json()) as { data: { users: Array<{ id: string; email: string }> } }
  const user = body.data.users.find((candidate) => candidate.email === email)
  if (!user) {
    throw new Error(`Workspace user not found for email ${email}`)
  }
  return user.id
}

test.describe("Reconnect Rehydration", () => {
  test("rehydrates the visible stream after reconnect without switching streams", async ({ browser, page }) => {
    const { testId, workspaceId } = await createWorkspaceSession(page, "reconnect-visible")

    const channelSlug = `reconnect-${testId}`
    const streamId = await createChannel(page, workspaceId, channelSlug)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

    const initialMessage = `initial ${testId}`
    await page.locator("[contenteditable='true']").click()
    await page.keyboard.type(initialMessage)
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page.getByRole("main").locator(".message-item").getByText(initialMessage).first()).toBeVisible({
      timeout: 10000,
    })

    const otherUser = await loginInNewContext(
      browser,
      `reconnect-other-${testId}@example.com`,
      `Reconnect Other ${testId}`
    )
    try {
      await joinWorkspaceAndChannel(otherUser.page, workspaceId, streamId)

      await page.context().setOffline(true)

      const reconnectMessage = `reconnect catch-up ${testId}`
      await sendMessageViaApi(otherUser.page, workspaceId, streamId, reconnectMessage)

      await page.context().setOffline(false)

      await expect(page.getByRole("main").locator(".message-item").getByText(reconnectMessage).first()).toBeVisible({
        timeout: 15000,
      })
    } finally {
      await otherUser.context.close()
    }
  })

  test("keeps the old UI visible and shows the topbar loading indicator during reconnect catch-up", async ({
    browser,
    page,
  }) => {
    const { testId, workspaceId } = await createWorkspaceSession(page, "reconnect-loading")

    const channelSlug = `reconnect-loading-${testId}`
    const streamId = await createChannel(page, workspaceId, channelSlug)

    let delayReconnectBootstrap = false
    await page.route("**/api/workspaces/**/streams/**/bootstrap**", async (route) => {
      const url = route.request().url()
      if (delayReconnectBootstrap && url.includes(`/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`)) {
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
      await route.continue()
    })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

    const initialMessage = `still visible ${testId}`
    await page.locator("[contenteditable='true']").click()
    await page.keyboard.type(initialMessage)
    await page.getByRole("button", { name: "Send" }).click()
    await expect(page.getByRole("main").locator(".message-item").getByText(initialMessage).first()).toBeVisible({
      timeout: 10000,
    })

    const otherUser = await loginInNewContext(
      browser,
      `reconnect-loading-other-${testId}@example.com`,
      `Reconnect Loading ${testId}`
    )
    try {
      await joinWorkspaceAndChannel(otherUser.page, workspaceId, streamId)

      await page.context().setOffline(true)

      const reconnectMessage = `delayed reconnect ${testId}`
      await sendMessageViaApi(otherUser.page, workspaceId, streamId, reconnectMessage)

      delayReconnectBootstrap = true
      await page.context().setOffline(false)

      await expect(page.getByRole("main").locator(".message-item").getByText(initialMessage).first()).toBeVisible({
        timeout: 5000,
      })

      await expect(page.getByRole("progressbar", { name: "Loading" })).toHaveCount(1, {
        timeout: 5000,
      })

      await expect(page.getByRole("main").locator(".message-item").getByText(reconnectMessage).first()).toBeVisible({
        timeout: 15000,
      })
    } finally {
      await otherUser.context.close()
    }
  })

  // Overflow → replace path is covered at the server level by
  // apps/backend/tests/e2e/stream-bootstrap.test.ts: "falls back to replace
  // with the latest 50 events when the cursor is too old". A browser-level
  // version of this test was attempted but proved flaky because Playwright's
  // `setOffline` does not reliably sever an already-open WebSocket, so the
  // client either keeps receiving broadcasts during the "offline" window or
  // sends `?after=<latest>` and legitimately receives an empty delta. Trust
  // the backend e2e for the overflow-replace contract.

  test("rehydrates the main stream and open thread panel together on reconnect", async ({ browser, page }) => {
    test.setTimeout(120000)

    const { testId, workspaceId } = await createWorkspaceSession(page, "reconnect-panel")

    const channelSlug = `reconnect-panel-${testId}`
    const streamId = await createChannel(page, workspaceId, channelSlug)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

    const parentMessage = `panel parent ${testId}`
    await page.locator("[contenteditable='true']").click()
    await page.keyboard.type(parentMessage)
    await page.keyboard.press("Meta+Enter")

    const parentContainer = page.getByRole("main").locator(".message-item").filter({ hasText: parentMessage }).first()
    await expect(parentContainer).toBeVisible({ timeout: 10000 })

    await clickReplyInThread(parentContainer)
    await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 10000 })

    const initialReply = `panel initial reply ${testId}`
    await sendPanelReply(page, initialReply)
    await expect(page.getByTestId("panel").getByText(initialReply)).toBeVisible({ timeout: 10000 })
    await waitForRealThreadPanel(page)

    const threadId = await page.getByTestId("panel").getAttribute("data-panel-tab")
    expect(threadId).toBeTruthy()
    expect(threadId?.startsWith("draft:")).toBe(false)

    const otherUser = await loginInNewContext(
      browser,
      `reconnect-panel-other-${testId}@example.com`,
      `Reconnect Panel ${testId}`
    )
    try {
      await joinWorkspaceAndChannel(otherUser.page, workspaceId, streamId)

      await page.context().setOffline(true)

      const mainReconnectMessage = `panel main reconnect ${testId}`
      const threadReconnectMessage = `panel thread reconnect ${testId}`
      await sendMessageViaApi(otherUser.page, workspaceId, streamId, mainReconnectMessage)
      await sendMessageViaApi(page, workspaceId, threadId!, threadReconnectMessage)

      await page.context().setOffline(false)

      await expect(page.getByRole("main").locator(".message-item").getByText(mainReconnectMessage).first()).toBeVisible(
        { timeout: 20000 }
      )
      await expect(page.getByTestId("panel").getByText(threadReconnectMessage)).toBeVisible({ timeout: 20000 })
    } finally {
      await otherUser.context.close()
    }
  })

  test("shows the correct stream error after reconnect when the visible stream becomes inaccessible", async ({
    browser,
    page,
  }) => {
    test.setTimeout(120000)

    const { testId, workspaceId } = await createWorkspaceSession(page, "reconnect-access")

    const channelSlug = `reconnect-access-${testId}`
    const streamId = await createChannel(page, workspaceId, channelSlug, "private")

    const memberEmail = `reconnect-access-other-${testId}@example.com`
    const otherUser = await loginInNewContext(browser, memberEmail, `Reconnect Access ${testId}`)
    try {
      await expectApiOk(
        await otherUser.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } }),
        "Join workspace"
      )
      const memberId = await getWorkspaceUserIdByEmail(page, workspaceId, memberEmail)
      await addMemberToChannel(page, workspaceId, streamId, memberId)

      await otherUser.page.goto(`/w/${workspaceId}/s/${streamId}`)
      await expect(otherUser.page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({
        timeout: 10000,
      })

      await otherUser.context.setOffline(true)
      await removeMemberFromChannel(page, workspaceId, streamId, memberId)
      await otherUser.context.setOffline(false)

      await expect(otherUser.page.getByText("The Thread Has Broken")).toBeVisible({ timeout: 20000 })
      await expect(otherUser.page.getByText("The path you seek has faded")).toBeVisible({ timeout: 20000 })
    } finally {
      await otherUser.context.close()
    }
  })
})
