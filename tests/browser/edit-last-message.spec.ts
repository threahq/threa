import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk, generateTestId } from "./helpers"

/**
 * E2E tests for the "press ArrowUp in empty composer to edit last message" feature.
 *
 * The Cancel button is the sentinel: it is only rendered inside the inline edit form,
 * so its presence/absence reliably signals whether edit mode is open.
 */

test.describe("Edit last message (ArrowUp)", () => {
  // All tests use a desktop viewport — the feature is desktop-only.
  test.use({ viewport: { width: 1280, height: 800 } })

  test("does nothing when the composer has content", async ({ page }) => {
    await loginAndCreateWorkspace(page, "elm-nonempty")

    await page.getByRole("button", { name: "+ New Scratchpad" }).click()
    await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    await page.keyboard.type("I am typing something")

    // ArrowUp with content in the editor should not open edit mode
    await page.keyboard.press("ArrowUp")

    await expect(page.getByRole("button", { name: "Cancel" })).not.toBeVisible()
    await expect(editor).toContainText("I am typing something")
  })

  test("does nothing when the composer has code block content", async ({ page }) => {
    await loginAndCreateWorkspace(page, "elm-nonempty-code")

    await page.getByRole("button", { name: "+ New Scratchpad" }).click()
    await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    await page.keyboard.type("```")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("const x = 1")

    await page.keyboard.press("ArrowUp")

    await expect(page.getByRole("button", { name: "Cancel" })).not.toBeVisible()
    await expect(editor.locator("pre")).toContainText("const x = 1")
  })

  test("opens the last message in edit mode when editor is empty", async ({ page }) => {
    await loginAndCreateWorkspace(page, "elm-basic")

    const channelName = `elm-basic-${Date.now()}`
    await createChannel(page, channelName, { switchToAll: false })
    await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

    const content = `Last message to edit ${Date.now()}`
    await page.locator("[contenteditable='true']").click()
    await page.keyboard.type(content)
    await page.keyboard.press("Enter")

    await expect(page.getByRole("main").locator(".message-item").getByText(content).first()).toBeVisible({
      timeout: 5000,
    })

    // Editor should be empty after sending before ArrowUp can trigger inline edit.
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled({ timeout: 5000 })
    await page.locator("[contenteditable='true']").click()
    await page.keyboard.press("ArrowUp")

    // Inline edit form opens
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible({ timeout: 3000 })
  })

  test("does nothing when the current user has no messages in the stream", async ({ page }) => {
    await loginAndCreateWorkspace(page, "elm-nomsg")

    await page.getByRole("button", { name: "+ New Scratchpad" }).click()
    await expect(page.locator("[contenteditable='true']")).toBeVisible({ timeout: 5000 })

    // No messages sent — press ArrowUp in empty editor
    await page.locator("[contenteditable='true']").click()
    await page.keyboard.press("ArrowUp")

    await expect(page.getByRole("button", { name: "Cancel" })).not.toBeVisible()
  })

  test("scrolls off-screen message into view and opens edit", async ({ browser }) => {
    test.setTimeout(90000)
    const testId = generateTestId()
    const channelName = `elm-scroll-${testId}`

    // ── User A: create workspace + channel, send first message ──
    const userA = await loginInNewContext(browser, `elm-a-${testId}@example.com`, `ELM A ${testId}`)
    await userA.page.setViewportSize({ width: 1280, height: 500 })

    const createWsRes = await userA.page.request.post("/api/workspaces", {
      data: { name: `ELM Scroll ${testId}` },
    })
    await expectApiOk(createWsRes, "Create workspace")
    const { workspace } = (await createWsRes.json()) as { workspace: { id: string } }
    const workspaceId = workspace.id

    await userA.page.goto(`/w/${workspaceId}`)
    await expect(userA.page.getByRole("button", { name: "+ New Channel" })).toBeVisible({ timeout: 10000 })
    await createChannel(userA.page, channelName, { switchToAll: false })

    const streamMatch = userA.page.url().match(/\/s\/([^/?]+)/)
    expect(streamMatch).toBeTruthy()
    const streamId = streamMatch![1]

    const firstMessage = `First A message ${testId}`
    await userA.page.locator("[contenteditable='true']").click()
    await userA.page.keyboard.type(firstMessage)
    await userA.page.getByRole("button", { name: "Send" }).click()
    await expect(userA.page.getByRole("main").locator(".message-item").getByText(firstMessage)).toBeVisible({
      timeout: 5000,
    })

    // ── User B: join and send many messages via API to push A's message off screen ──
    const userB = await loginInNewContext(browser, `elm-b-${testId}@example.com`, `ELM B ${testId}`)

    await userB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } })
    await userB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)

    // Send 20 messages via API (much faster than UI interactions)
    const fillerText = `Filler B ${testId}`
    for (let i = 1; i <= 20; i++) {
      await userB.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: {
          streamId,
          contentJson: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: `${fillerText} #${i}` }] }],
          },
          contentMarkdown: `${fillerText} #${i}`,
        },
      })
    }

    // ── User A: hard-reload to get a fresh bootstrap with filler messages ──
    // Navigate to about:blank first to fully teardown React state (TanStack cache,
    // hook state), then navigate to the stream URL. This gets a clean bootstrap from
    // the database which now has all 20 fillers plus User A's original message.
    await userA.page.goto("about:blank")
    await userA.page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(userA.page.locator("[contenteditable='true']")).toBeVisible({ timeout: 15000 })

    const lastFillerEl = userA.page.getByRole("main").locator(".message-item").getByText(`${fillerText} #20`).first()
    await expect(lastFillerEl).toBeVisible({ timeout: 15000 })

    // After bootstrap + initial auto-scroll, the latest message should be in viewport
    // and User A's first message should be scrolled off-screen
    const firstMessageEl = userA.page.getByRole("main").locator(".message-item").getByText(firstMessage).first()
    await expect(firstMessageEl).not.toBeInViewport({ timeout: 5000 })

    // Press ArrowUp in the empty composer
    await userA.page.locator("[contenteditable='true']").click()
    await userA.page.keyboard.press("ArrowUp")

    // Inline edit form should open
    await expect(userA.page.getByRole("button", { name: "Cancel" })).toBeVisible({ timeout: 5000 })
    // First message should now be scrolled into view. Generous timeout: the
    // scroll-into-view runs after the edit form mounts and re-measures, which
    // lands well past 5s on a cold/loaded backend.
    await expect(firstMessageEl).toBeInViewport({ timeout: 15000 })

    await userA.context.close()
    await userB.context.close()
  })

  test("does nothing when the user's only message is outside the loaded bootstrap window", async ({ browser }) => {
    test.setTimeout(90000)
    const testId = generateTestId()
    const channelName = `elm-window-${testId}`
    const userAEmail = `elm-win-a-${testId}@example.com`
    const userAName = `ELM Win A ${testId}`

    // ── User A: create workspace + channel, send first message ──
    const userA = await loginInNewContext(browser, userAEmail, userAName)

    const createWsRes = await userA.page.request.post("/api/workspaces", {
      data: { name: `ELM Window ${testId}` },
    })
    await expectApiOk(createWsRes, "Create workspace")
    const { workspace } = (await createWsRes.json()) as { workspace: { id: string } }
    const workspaceId = workspace.id

    await userA.page.goto(`/w/${workspaceId}`)
    await expect(userA.page.getByRole("button", { name: "+ New Channel" })).toBeVisible({ timeout: 10000 })
    await createChannel(userA.page, channelName, { switchToAll: false })

    const streamMatch = userA.page.url().match(/\/s\/([^/?]+)/)
    expect(streamMatch).toBeTruthy()
    const streamId = streamMatch![1]

    const oldMessage = `Old message outside window ${testId}`
    const oldMessageResponse = await userA.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: {
        streamId,
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: oldMessage }] }],
        },
        contentMarkdown: oldMessage,
      },
    })
    await expectApiOk(oldMessageResponse, "Create old message outside bootstrap window")

    // ── User B: join workspace + channel, flood with 60 filler messages ──
    // Fillers must come from a different user so User A's only message remains the old one.
    const userB = await loginInNewContext(browser, `elm-win-b-${testId}@example.com`, `ELM Win B ${testId}`)
    await userB.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } })
    await userB.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`)

    const fillerText = `Filler Win ${testId}`
    for (let i = 1; i <= 60; i++) {
      const fillerResponse = await userB.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: {
          streamId,
          contentJson: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: `${fillerText} #${i}` }] }],
          },
          contentMarkdown: `${fillerText} #${i}`,
        },
      })
      await expectApiOk(fillerResponse, `Create filler message #${i}`)
    }

    // ── User A: reopen the stream in a fresh browser context so IDB/socket state
    // from the original session cannot leak older messages into the bootstrap test.
    await userA.context.close()
    const reloadedUserA = await loginInNewContext(browser, userAEmail, userAName)
    await reloadedUserA.page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(reloadedUserA.page.locator("[contenteditable='true']")).toBeVisible({ timeout: 15000 })

    // Wait for the latest filler to be rendered — proves bootstrap has loaded.
    await expect(
      reloadedUserA.page.getByRole("main").locator(".message-item").getByText(`${fillerText} #60`)
    ).toBeVisible({
      timeout: 15000,
    })

    // The old message should not be visible — it's outside the bootstrap window.
    const oldMessageInTimeline = reloadedUserA.page.getByRole("main").locator(".message-item").getByText(oldMessage)
    await expect(oldMessageInTimeline).not.toBeVisible({ timeout: 10000 })
    await reloadedUserA.page.waitForTimeout(500)
    await expect(oldMessageInTimeline).not.toBeVisible({ timeout: 1000 })

    // Press ArrowUp — the old message is not registered (not mounted), so nothing happens
    const reloadedEditor = reloadedUserA.page.locator("[contenteditable='true']")
    await reloadedEditor.click()
    await expect(reloadedEditor).toBeFocused({ timeout: 5000 })
    await reloadedUserA.page.keyboard.press("ArrowUp")

    await expect(reloadedUserA.page.getByRole("button", { name: "Cancel" })).not.toBeVisible()

    await reloadedUserA.context.close()
    await userB.context.close()
  })
})
