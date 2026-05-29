import { test, expect, type Locator, type Page } from "@playwright/test"
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
 * 3. **Private → public, blocked then confirmed.** Two-user scenario where
 *    sharing from a private channel into a public one User B has joined
 *    triggers `crossesPrivacyBoundary`. The first send must fail with the
 *    `blocked-privacy` status, surface the toast, and only after the user
 *    explicitly clicks "Share anyway" should the pointer reach the public
 *    timeline. **The whole point of this test is to prove a share never
 *    leaves the device without a deliberate user click.**
 * 4. **Private → public, blocked then cancelled.** Same setup, but Cancel
 *    on the toast must drop the pending row and never deliver the share.
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
 * bootstrap. Used to admin-add User B to the public channel so the
 * `stream_members` row exists — `crossesPrivacyBoundary`'s exposure count is
 * over `stream_members`, not "every workspace member with read access".
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

    // Modal closes and we navigate to the target. Composer pre-fills with
    // the share node — send via the normal Enter shortcut.
    await expect(dialog).not.toBeVisible()
    const composer = page.locator("[contenteditable='true']").first()
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

  test("blocks a private→public share until the user explicitly confirms 'Share anyway'", async ({ browser, page }) => {
    // ---- Setup: two users, one workspace, two channels --------------------
    // User A owns the workspace and is the only member of the private source.
    // User B joins the workspace and is added to the public target so the
    // backend's exposure count is > 0 (User B is in `pub`'s stream_members
    // but NOT in `priv`'s — exactly the case the privacy boundary is meant
    // to catch).
    const { testId, workspaceId } = await loginAndCreateWorkspace(page, "share-priv-confirm").then((r) => ({
      testId: r.testId,
      workspaceId: page.url().match(/\/w\/([^/]+)/)?.[1] ?? "",
    }))
    expect(workspaceId).not.toBe("")

    const pubSlug = `pub-${testId}`
    const privSlug = `priv-${testId}`
    const pubStreamId = await createChannelViaApi(page, workspaceId, pubSlug, "public")
    const privStreamId = await createChannelViaApi(page, workspaceId, privSlug, "private")

    const memberEmail = `share-priv-other-${testId}@example.com`
    const otherUser = await loginInNewContext(browser, memberEmail, `Share Priv Other ${testId}`)
    try {
      await expectApiOk(
        await otherUser.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } }),
        "User B join workspace"
      )
      const memberId = await getWorkspaceUserIdByEmail(page, workspaceId, memberEmail)
      // Admin-add User B to the public channel so the stream_members row
      // exists. A drive-by `joinChannel` from User B's session would also
      // work for public channels, but going through the owner keeps the test
      // independent of User B's UI state.
      await expectApiOk(
        await page.request.post(`/api/workspaces/${workspaceId}/streams/${pubStreamId}/members`, {
          data: { memberId },
        }),
        "Add User B to public channel"
      )

      // ---- Act: User A sends a private message, opens picker, selects pub.
      await page.goto(`/w/${workspaceId}/s/${privStreamId}`)
      await expect(page.getByRole("heading", { name: `#${privSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

      const sourceText = `secret-${testId}`
      await sendChannelMessageViaApi(page, sourceText)
      await expect(mainMessageRow(page, sourceText)).toBeVisible({ timeout: 5000 })

      await openMessageContextMenu(page, sourceText)
      await page.getByRole("menuitem", { name: /^share message$/i }).click()

      const dialog = page.getByRole("dialog", { name: /share message/i })
      await expect(dialog).toBeVisible()
      const pubItem = dialog
        .locator("[cmdk-item][data-value]")
        .filter({ hasText: new RegExp(pubSlug, "i") })
        .first()
      await expect(pubItem).toBeVisible()
      await pubItem.click()

      // Modal closes, navigation lands on `pub`, composer receives the share.
      await expect(dialog).not.toBeVisible()
      await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/s/${pubStreamId}`), { timeout: 10000 })
      const composer = page.locator("[contenteditable='true']").first()
      await expect(composer.locator("[data-type='shared-message']")).toHaveCount(1, { timeout: 5000 })
      await composer.focus()
      await page.keyboard.press("Enter")

      // ---- Assert: NOT delivered. Toast appears asking for confirmation.
      // The toast is the only thing standing between an accidental click and
      // the source content reaching User B — its presence is the contract.
      const toast = page.getByText(/expose the source to people outside the source stream/i)
      await expect(toast).toBeVisible({ timeout: 10000 })

      // The real privacy contract is about the *recipient*. A rejected send
      // still renders locally for the sender as an optimistic "Failed to send"
      // bubble (with Retry) in their own timeline — that's a device-local UI
      // state, not a leak. What must hold is that User B, who is in `pub` but
      // not in the private source, never receives the pointer before User A
      // explicitly confirms. Verify that from User B's own session.
      const otherPointer = otherUser.page
        .getByRole("main")
        .locator("[data-type='shared-message']")
        .filter({ hasText: new RegExp(sourceText) })
      await otherUser.page.goto(`/w/${workspaceId}/s/${pubStreamId}`)
      await expect(otherUser.page.getByRole("heading", { name: `#${pubSlug}`, level: 1 })).toBeVisible({
        timeout: 10000,
      })
      await expect(otherPointer).toHaveCount(0)

      // ---- Confirm: click "Share anyway" → re-enqueue with the flag set.
      await page.getByRole("button", { name: /share anyway/i }).click()

      // Now — and only now — the pointer is delivered. User A's failed bubble
      // settles into a delivered pointer, and User B receives it over the
      // socket into the already-open `pub` timeline.
      const publishedPointer = page
        .getByRole("main")
        .locator("[data-type='shared-message']")
        .filter({ hasText: new RegExp(sourceText) })
      await expect(publishedPointer).toBeVisible({ timeout: 10000 })
      await expect(otherPointer).toBeVisible({ timeout: 10000 })

      // The toast should be dismissed once the retry is in flight.
      await expect(toast).not.toBeVisible({ timeout: 5000 })
    } finally {
      await otherUser.context.close()
    }
  })

  test("blocks a private→public share and discards it cleanly when the user clicks 'Cancel'", async ({
    browser,
    page,
  }) => {
    // Mirrors the confirm test up to the toast — then asserts the cancel path
    // tears down the optimistic state without ever hitting the server.
    const { testId, workspaceId } = await loginAndCreateWorkspace(page, "share-priv-cancel").then((r) => ({
      testId: r.testId,
      workspaceId: page.url().match(/\/w\/([^/]+)/)?.[1] ?? "",
    }))
    expect(workspaceId).not.toBe("")

    const pubSlug = `pub-${testId}`
    const privSlug = `priv-${testId}`
    const pubStreamId = await createChannelViaApi(page, workspaceId, pubSlug, "public")
    const privStreamId = await createChannelViaApi(page, workspaceId, privSlug, "private")

    const memberEmail = `share-priv-cancel-other-${testId}@example.com`
    const otherUser = await loginInNewContext(browser, memberEmail, `Share Priv Cancel ${testId}`)
    try {
      await expectApiOk(
        await otherUser.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } }),
        "User B join workspace"
      )
      const memberId = await getWorkspaceUserIdByEmail(page, workspaceId, memberEmail)
      await expectApiOk(
        await page.request.post(`/api/workspaces/${workspaceId}/streams/${pubStreamId}/members`, {
          data: { memberId },
        }),
        "Add User B to public channel"
      )

      await page.goto(`/w/${workspaceId}/s/${privStreamId}`)
      await expect(page.getByRole("heading", { name: `#${privSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

      const sourceText = `do-not-leak-${testId}`
      await sendChannelMessageViaApi(page, sourceText)
      await expect(mainMessageRow(page, sourceText)).toBeVisible({ timeout: 5000 })

      await openMessageContextMenu(page, sourceText)
      await page.getByRole("menuitem", { name: /^share message$/i }).click()

      const dialog = page.getByRole("dialog", { name: /share message/i })
      await expect(dialog).toBeVisible()
      const pubItem = dialog
        .locator("[cmdk-item][data-value]")
        .filter({ hasText: new RegExp(pubSlug, "i") })
        .first()
      await expect(pubItem).toBeVisible()
      await pubItem.click()
      await expect(dialog).not.toBeVisible()
      await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/s/${pubStreamId}`), { timeout: 10000 })

      const composer = page.locator("[contenteditable='true']").first()
      await expect(composer.locator("[data-type='shared-message']")).toHaveCount(1, { timeout: 5000 })
      await composer.focus()
      await page.keyboard.press("Enter")

      const toast = page.getByText(/expose the source to people outside the source stream/i)
      await expect(toast).toBeVisible({ timeout: 10000 })

      await page.getByRole("button", { name: /^cancel$/i }).click()

      // Toast dismisses; pointer never appears in the public timeline. We
      // wait long enough for any (hypothetical) deferred retry to drain so
      // the absence assertion is meaningful, not just a race.
      await expect(toast).not.toBeVisible({ timeout: 5000 })
      await page.waitForTimeout(2000)
      const publishedPointer = page
        .getByRole("main")
        .locator("[data-type='shared-message']")
        .filter({ hasText: new RegExp(sourceText) })
      await expect(publishedPointer).toHaveCount(0)

      // Independent verification from User B's perspective: User B is in `pub`
      // and would see any leaked share. Bootstrap the public channel as User B
      // and assert no share-pointer messages exist for the source text. This
      // closes the loop between "frontend optimistic state cleared" and
      // "backend never accepted the write".
      await otherUser.page.goto(`/w/${workspaceId}/s/${pubStreamId}`)
      await expect(otherUser.page.getByRole("heading", { name: `#${pubSlug}`, level: 1 })).toBeVisible({
        timeout: 10000,
      })
      const otherPointer = otherUser.page
        .getByRole("main")
        .locator("[data-type='shared-message']")
        .filter({ hasText: new RegExp(sourceText) })
      await expect(otherPointer).toHaveCount(0)
    } finally {
      await otherUser.context.close()
    }
  })
})
