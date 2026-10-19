import { test, expect, type Browser, type Locator, type Page } from "@playwright/test"
import { createChannel, expectApiOk, generateTestId, loginAndCreateWorkspace, loginInNewContext } from "./helpers"

/**
 * E2E coverage for Slice 2 of message sharing — the cross-stream picker
 * modal. Covers the single-user happy paths plus the two-user privacy-
 * boundary flows that gate accidental information leaks:
 *
 * 1. **Cross-stream into a scratchpad (public source).** Share a message
 *    from a public channel into the user's own scratchpad. No privacy
 *    boundary fires. Asserts the picker filters correctly and the pointer
 *    lands hydrated in the target stream.
 * 2. **Same-stream share.** Share a message into the stream it lives in.
 *    Plan D5 says this is allowed; the hand-off lands in the current
 *    composer and the user can send a duplicate pointer back.
 * 3. **Private → public, asked before send.** A second describe block covers
 *    the composer's in-place question: nothing reaches User B (in the public
 *    channel, not the private source) until User A answers it.
 *
 * The recursive private-placeholder rechain scenario from the plan
 * (E2E-share-rechain-private-placeholder) is covered exhaustively at
 * unit-test level in `hydration.test.ts` and `card-body.test.tsx`.
 */

async function sendChannelMessageViaApi(page: Page, text: string): Promise<string> {
  const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
  expect(match).toBeTruthy()
  const [, workspaceId, streamId] = match!
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: {
      streamId,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      contentMarkdown: text,
    },
  })
  await expectApiOk(response, `Create stream message: ${text}`)
  const body = (await response.json()) as { message?: { id: string } }
  return body.message?.id ?? ""
}

/**
 * Create a channel directly via the streams API rather than the modal — the
 * privacy tests need a private channel and the in-app modal only exposes a
 * "public channel" affordance to keep workspace creation simple.
 */
async function createChannelViaApi(
  page: Page,
  workspaceId: string,
  slug: string,
  visibility: "public" | "private"
): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug, visibility },
  })
  await expectApiOk(response, `Create ${visibility} channel ${slug}`)
  const body = (await response.json()) as { stream: { id: string } }
  return body.stream.id
}

/**
 * Resolve the workspace user id for a given email by reading the workspace
 * bootstrap. Used to admin-add User B to the public channel.
 */
async function getWorkspaceUserIdByEmail(page: Page, workspaceId: string, email: string): Promise<string> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(response, "Get workspace bootstrap")
  const body = (await response.json()) as { data: { users: Array<{ id: string; email: string }> } }
  const user = body.data.users.find((candidate) => candidate.email === email)
  if (!user) throw new Error(`Workspace user not found for email ${email}`)
  return user.id
}

/**
 * Locate a message row by its text within the main timeline. Scoping to
 * `main` matters: the channel's last-message preview in the sidebar
 * (`navigation`) also renders the message text but has no `data-message-id`
 * ancestor, so an unscoped `getByText(...).first()` grabs the preview and the
 * row lookup resolves to nothing.
 */
function mainMessageRow(page: Page, text: string): Locator {
  return page.getByRole("main").locator("[data-message-id]").filter({ hasText: text }).first()
}

async function openMessageContextMenu(page: Page, text: string): Promise<void> {
  const row = mainMessageRow(page, text)
  await row.hover()
  await row.getByRole("button", { name: /message actions/i }).click()
}

/**
 * Create a scratchpad via the streams API. The in-sidebar "+ New Scratchpad"
 * affordance only renders in the empty state or the "All" preset's Scratchpads
 * section, so it's not reachable from the default Smart preset this test runs
 * in. The picker reads its targets from the workspace bootstrap, so an
 * API-created scratchpad shows up once the source stream is (re)loaded.
 */
async function createScratchpad(page: Page): Promise<string> {
  const workspaceId = page.url().match(/\/w\/([^/]+)/)?.[1] ?? ""
  expect(workspaceId, "workspace id should be resolvable from the URL").not.toBe("")
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "scratchpad" },
  })
  await expectApiOk(response, "Create scratchpad")
  const body = (await response.json()) as { stream: { id: string } }
  return body.stream.id
}

test.describe("Message share — cross-stream picker modal (Slice 2)", () => {
  let testId: string

  test.beforeEach(async ({ page }) => {
    const result = await loginAndCreateWorkspace(page, "share-x-stream")
    testId = result.testId
  })

  test("shares a public-channel message into the user's scratchpad via the picker", async ({ page }) => {
    const channelName = `pub-${testId}`
    await createChannel(page, channelName, { switchToAll: false })
    const sourceText = `source-msg-${testId}`
    await sendChannelMessageViaApi(page, sourceText)

    const sourceUrl = page.url()
    const sourceStreamId = new URL(sourceUrl).pathname.split("/s/")[1]
    // Pre-create the scratchpad target so it shows up in the picker.
    await createScratchpad(page)
    // Hop back to the source channel.
    await page.goto(sourceUrl)
    await expect(page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible()

    await openMessageContextMenu(page, sourceText)
    // The default "Share message" entry — opens the picker modal.
    await page.getByRole("menuitem", { name: /^share message$/i }).click()

    // Picker dialog opens. The scratchpad we just created is selectable.
    const dialog = page.getByRole("dialog", { name: /share message/i })
    await expect(dialog).toBeVisible()
    const target = dialog.locator(`[cmdk-item][data-value]`).first()
    await expect(target).toBeVisible()
    // Click whichever scratchpad-row is exposed; in the no-named-scratchpad
    // case the list shows just our newly-created untitled one.
    const scratchItem = dialog
      .locator("[cmdk-item][data-value]")
      .filter({ hasText: /scratchpad|saved|notes|untitled/i })
      .first()
    if ((await scratchItem.count()) > 0) {
      await scratchItem.click()
    } else {
      // Fallback: the only non-channel option is the scratchpad anyway.
      await target.click()
    }

    // Modal closes and the target opens beside the source, which stays mounted. Its composer pre-fills with the
    // share node — send via the normal Enter shortcut.
    await expect(dialog).not.toBeVisible()
    await expect(page).not.toHaveURL(new RegExp(`/s/${sourceStreamId}`))
    const targetStreamId = new URL(page.url()).pathname.split("/s/")[1]
    expect(new URL(page.url()).searchParams.get("panel")).toBe(`${sourceStreamId}-${targetStreamId}`)
    await expect(page.locator(`[data-panel-tab="${sourceStreamId}"]`).getByText(sourceText)).toBeVisible()
    const composer = page.locator(`[data-panel-tab="${targetStreamId}"] [contenteditable='true']`)
    await expect(composer).toBeVisible()
    await expect(composer.locator("[data-type='shared-message']")).toHaveCount(1, { timeout: 5000 })
    await composer.focus()
    await page.keyboard.press("Enter")

    // Sent — pointer card lands hydrated in the target stream.
    await expect(page.locator("[data-type='shared-message']").filter({ hasText: new RegExp(sourceText) })).toBeVisible({
      timeout: 5000,
    })
  })

  test("supports same-stream share — handoff lands in the current composer", async ({ page }) => {
    const channelName = `self-${testId}`
    await createChannel(page, channelName, { switchToAll: false })
    const sourceText = `self-share-msg-${testId}`
    await sendChannelMessageViaApi(page, sourceText)

    await openMessageContextMenu(page, sourceText)
    await page.getByRole("menuitem", { name: /^share message$/i }).click()

    const dialog = page.getByRole("dialog", { name: /share message/i })
    await expect(dialog).toBeVisible()
    // Pick the same channel we're already in.
    const sameItem = dialog
      .locator("[cmdk-item][data-value]")
      .filter({ hasText: new RegExp(channelName, "i") })
      .first()
    await expect(sameItem).toBeVisible()
    await sameItem.click()

    // Modal closes, current composer receives the share node — no
    // navigation flicker since target === current.
    await expect(dialog).not.toBeVisible()
    const composer = page.locator("[contenteditable='true']").first()
    await expect(composer.locator("[data-type='shared-message']")).toHaveCount(1, { timeout: 5000 })
    await composer.focus()
    await page.keyboard.press("Enter")

    // The channel now contains the original message AND a hydrated share
    // pointer to it. Two `[data-type='shared-message']` would only render in
    // the timeline if the send went through — the composer's transient one
    // disappears post-send.
    await expect(page.locator("[data-type='shared-message']").filter({ hasText: new RegExp(sourceText) })).toBeVisible({
      timeout: 5000,
    })
  })
})

const PHONE = { width: 390, height: 780 }

/**
 * User A owns the workspace and is the only member of a private channel; User B
 * joins the workspace and a public channel. Anything from the private channel
 * that A puts into the public channel's composer reaches a reader who can't open
 * its source — the case the composer asks about before it sends.
 */
async function setupPrivateToPublic(browser: Browser, page: Page, prefix: string) {
  const { testId } = await loginAndCreateWorkspace(page, prefix)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)?.[1] ?? ""
  expect(workspaceId).not.toBe("")

  const pubSlug = `pub-${testId}`
  const privSlug = `priv-${testId}`
  const pubStreamId = await createChannelViaApi(page, workspaceId, pubSlug, "public")
  const privStreamId = await createChannelViaApi(page, workspaceId, privSlug, "private")

  const otherName = `Reader ${testId}`
  const otherEmail = `${prefix}-other-${testId}@example.com`
  const other = await loginInNewContext(browser, otherEmail, otherName)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: otherName },
    }),
    "User B join workspace"
  )
  const memberId = await getWorkspaceUserIdByEmail(page, workspaceId, otherEmail)
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/streams/${pubStreamId}/members`, { data: { memberId } }),
    "Add User B to public channel"
  )

  await page.goto(`/w/${workspaceId}/s/${privStreamId}`)
  await expect(page.getByRole("heading", { name: `#${privSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })
  const sourceText = `secret-${testId}`
  const sourceMessageId = await sendChannelMessageViaApi(page, sourceText)
  await expect(mainMessageRow(page, sourceText)).toBeVisible({ timeout: 5000 })

  return { workspaceId, pubSlug, pubStreamId, privStreamId, other, otherName, sourceText, sourceMessageId }
}

type PrivateToPublic = Awaited<ReturnType<typeof setupPrivateToPublic>>

/** Share the private source into the public channel through the picker; returns the public pane. */
async function shareIntoPublic(page: Page, setup: PrivateToPublic): Promise<Locator> {
  await openMessageContextMenu(page, setup.sourceText)
  await page.getByRole("menuitem", { name: /^share message$/i }).click()
  const dialog = page.getByRole("dialog", { name: /share message/i })
  await dialog
    .locator("[cmdk-item][data-value]")
    .filter({ hasText: new RegExp(setup.pubSlug, "i") })
    .first()
    .click()
  await expect(dialog).not.toBeVisible()
  const pane = page.locator(`[data-panel-tab="${setup.pubStreamId}"]`)
  await expect(pane.locator("[contenteditable='true'] [data-type='shared-message']")).toHaveCount(1, { timeout: 5000 })
  return pane
}

/** User B's view of the public channel: the timeline's share pointers and link chips. */
async function openAsOtherReader(setup: PrivateToPublic) {
  const page = setup.other.page
  await page.goto(`/w/${setup.workspaceId}/s/${setup.pubStreamId}`)
  await expect(page.getByRole("heading", { name: `#${setup.pubSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })
  const timeline = page.getByRole("main").locator("[data-message-id]")
  return {
    pointers: timeline.locator("[data-type='shared-message']").filter({ hasText: setup.sourceText }),
    chips: timeline.locator("[data-type='in-app-link-chip']"),
  }
}

async function pasteIntoFocusedComposer(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const editor = document.activeElement
    if (!(editor instanceof HTMLElement) || !editor.isContentEditable) throw new Error("No focused composer")
    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", value)
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

test.describe("Composer asks before a reference reaches readers who can't open it", () => {
  test("a share asks in place and only goes out after the second Send", async ({ browser, page }) => {
    const setup = await setupPrivateToPublic(browser, page, "ask-share")
    try {
      const pane = await shareIntoPublic(page, setup)
      await expect(pane.getByTestId("send-warning-badge").first()).toHaveAttribute("data-tone", "reveal")

      await pane.locator("[contenteditable='true']").focus()
      await page.keyboard.press("Enter")
      const ask = pane.getByTestId("send-ask")
      await expect(ask).toContainText(`${setup.otherName} will see this message`)

      const reader = await openAsOtherReader(setup)
      await expect(reader.pointers).toHaveCount(0)

      // The question's Send holds focus, so a second Enter is the deliberate confirm.
      await page.keyboard.press("Enter")
      await expect(ask).toHaveCount(0)
      await expect(reader.pointers).toBeVisible({ timeout: 10000 })
    } finally {
      await setup.other.context.close()
    }
  })

  test("when the audience lookup fails, the server still stops the share until Share anyway", async ({
    browser,
    page,
  }) => {
    const setup = await setupPrivateToPublic(browser, page, "ask-lookup-down")
    try {
      await page.route("**/messages/reference-audience", (route) => route.fulfill({ status: 500, body: "{}" }))
      const pane = await shareIntoPublic(page, setup)
      await pane.locator("[contenteditable='true']").focus()
      await page.keyboard.press("Enter")
      await expect(pane.getByTestId("send-ask")).toHaveCount(0)

      const shareAnyway = page.getByRole("button", { name: "Share anyway" })
      await expect(shareAnyway).toBeVisible({ timeout: 10000 })
      const reader = await openAsOtherReader(setup)
      await expect(reader.pointers).toHaveCount(0)

      await shareAnyway.click()
      await expect(reader.pointers).toBeVisible({ timeout: 10000 })
    } finally {
      await setup.other.context.close()
    }
  })

  test("Escape drops the question and the share stays in the draft, unsent", async ({ browser, page }) => {
    const setup = await setupPrivateToPublic(browser, page, "ask-escape")
    try {
      const pane = await shareIntoPublic(page, setup)
      const editor = pane.locator("[contenteditable='true']")
      await editor.focus()
      await page.keyboard.press("Enter")
      await expect(pane.getByTestId("send-ask")).toBeVisible()

      await page.keyboard.press("Escape")
      await expect(pane.getByTestId("send-ask")).toHaveCount(0)
      await expect(editor.locator("[data-type='shared-message']")).toHaveCount(1)

      // Long enough for a send that had slipped through to land.
      await page.waitForTimeout(2000)
      const reader = await openAsOtherReader(setup)
      await expect(reader.pointers).toHaveCount(0)
    } finally {
      await setup.other.context.close()
    }
  })

  test("Use link swaps the share for a link and the next Send doesn't ask again", async ({ browser, page }) => {
    const setup = await setupPrivateToPublic(browser, page, "ask-use-link")
    try {
      const pane = await shareIntoPublic(page, setup)
      const editor = pane.locator("[contenteditable='true']")
      await editor.focus()
      await page.keyboard.press("Enter")
      await pane
        .getByTestId("send-ask")
        .getByRole("button", { name: /^(Use )?link$/i })
        .click()

      await expect(editor.locator("[data-type='shared-message']")).toHaveCount(0)
      await expect(editor.locator("[data-type='in-app-link-chip'] .lucide-lock")).toBeVisible({ timeout: 5000 })
      await expect(pane.getByTestId("send-warning-badge").first()).toHaveAttribute("data-tone", "unreachable")

      await expect(editor).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(pane.getByTestId("send-ask")).toHaveCount(0)

      const reader = await openAsOtherReader(setup)
      await expect(reader.chips).toHaveCount(1, { timeout: 10000 })
      await expect(reader.pointers).toHaveCount(0)
    } finally {
      await setup.other.context.close()
    }
  })

  test("on a phone, a link someone can't open offers Share, and the share then sends", async ({ browser, page }) => {
    const setup = await setupPrivateToPublic(browser, page, "ask-mobile")
    try {
      await page.setViewportSize(PHONE)
      await page.goto(`/w/${setup.workspaceId}/s/${setup.pubStreamId}`)
      const main = page.getByRole("main")
      // At rest the phone composer's editor is a hairline; the card is the tap target.
      const card = main.locator("[data-composer-card]").last()
      const box = await card.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.click(box!.x + box!.width / 2, box!.y + 18)
      const editor = main.locator("[data-editor-zone='main'] [contenteditable='true']").first()
      await expect(editor).toBeFocused()
      const origin = new URL(page.url()).origin
      await pasteIntoFocusedComposer(
        page,
        `${origin}/w/${setup.workspaceId}/s/${setup.privStreamId}?m=${setup.sourceMessageId}`
      )
      await expect(editor.locator("[data-type='in-app-link-chip'] .lucide-lock")).toBeVisible({ timeout: 5000 })

      const send = main.getByRole("button", { name: `Send — ${setup.otherName} can't open it` })
      await send.click()
      const ask = main.getByTestId("send-ask")
      await expect(ask).toContainText(`${setup.otherName} can't open it`)

      await ask.getByRole("button", { name: "Share", exact: true }).click()
      await expect(editor.locator("[data-type='shared-message']")).toHaveCount(1)
      await expect(ask).toHaveCount(0)

      // Choosing Share answered the question; the send goes out confirmed.
      await main.getByRole("button", { name: /^Send\b/ }).click()
      await expect(ask).toHaveCount(0)
      const reader = await openAsOtherReader(setup)
      await expect(reader.pointers).toBeVisible({ timeout: 10000 })
    } finally {
      await setup.other.context.close()
    }
  })
})
