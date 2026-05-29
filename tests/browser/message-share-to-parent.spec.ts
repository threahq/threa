import { test, expect, type Locator, type Page } from "@playwright/test"
import {
  clickReplyInThread,
  createChannel,
  expectApiOk,
  generateTestId,
  loginAndCreateWorkspace,
  sendPanelReply,
  waitForRealThreadPanel,
} from "./helpers"

/**
 * E2E coverage for Slice 1 of message sharing — the fast-path "share to
 * parent" action.
 *
 * Scenarios exercised:
 * 1. Share-to-parent: click the "Share to #channel" entry on a thread
 *    message, verify the parent channel's composer receives a
 *    sharedMessage node, send via the normal composer, and the pointer
 *    renders in the channel with hydrated content.
 * 2. Pointer edit propagation: edit the source (thread) message via the
 *    messages API and confirm the pointer in the parent channel reflects
 *    the edit (realtime `pointer:invalidated` → bootstrap refetch).
 * 3. Pointer delete tombstone: soft-delete the source message via the
 *    messages API and confirm the pointer renders the "Message deleted"
 *    tombstone via the same invalidation path.
 *
 * Tests 2 and 3 run in a single browser context: the same user that
 * created the source thread reply edits/deletes it, then watches the
 * pointer in the channel update. No two-context fixture needed.
 */

async function sendChannelMessageViaApi(page: Page, text: string): Promise<string> {
  const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
  expect(match).toBeTruthy()
  const [, workspaceId, streamId] = match!

  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: {
      streamId,
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
      contentMarkdown: text,
    },
  })
  await expectApiOk(response, `Create stream message: ${text}`)
  const body = (await response.json()) as { message?: { id: string }; id?: string }
  return body.message?.id ?? body.id ?? ""
}

/**
 * Locate a message row by its text within the main timeline. Scoping to
 * `main` matters: the channel's last-message preview in the sidebar
 * (`navigation`) also renders the message text, but it has no
 * `data-message-id` ancestor, so an unscoped `getByText(...).first()` grabs
 * the preview and the row lookup resolves to nothing.
 */
function mainMessageRow(page: Page, text: string): Locator {
  return page.getByRole("main").locator("[data-message-id]").filter({ hasText: text }).first()
}

/** Locate a message row by its text within the open thread panel. */
function panelMessageRow(page: Page, text: string): Locator {
  return page.getByTestId("panel").locator("[data-message-id]").filter({ hasText: text }).first()
}

async function openRowContextMenu(row: Locator): Promise<void> {
  await row.hover()
  await row.getByRole("button", { name: /message actions/i }).click()
}

/**
 * Set up a shared-pointer scenario end-to-end: create a channel, send a
 * parent message, open its thread, send a reply, share the reply back up
 * to the channel, and wait for the pointer card to render hydrated.
 *
 * Returns the IDs the edit/delete tests need to mutate the source via the
 * API and observe the pointer update.
 */
async function setUpSharedPointer(
  page: Page,
  opts: { channelName: string; threadText: string }
): Promise<{ workspaceId: string; channelStreamId: string; threadMessageId: string }> {
  await createChannel(page, opts.channelName, { switchToAll: false })

  const parentText = `Parent ${generateTestId()}`
  await sendChannelMessageViaApi(page, parentText)

  const parentRow = mainMessageRow(page, parentText)
  await expect(parentRow).toBeVisible()
  await clickReplyInThread(parentRow)

  // Threads are created lazily: the panel stays a `draft:` until the first
  // reply is sent, so the reply must go in before we wait for the panel to
  // settle into a real thread (canonical order in
  // `nested-thread-navigation.spec.ts`).
  await sendPanelReply(page, opts.threadText)
  await waitForRealThreadPanel(page)

  // Capture the thread-reply's message id — that's the source we'll later
  // edit / delete via the API and watch propagate to the channel pointer.
  const threadRow = panelMessageRow(page, opts.threadText)
  await expect(threadRow).toBeVisible()
  const threadMessageId = (await threadRow.getAttribute("data-message-id")) ?? ""
  expect(threadMessageId, "thread reply should expose data-message-id").not.toBe("")

  await openRowContextMenu(threadRow)
  // The default `share` entry (modal) sits as the primary in the share group;
  // share-to-root and share-to-parent ride alongside as alternatives behind
  // the chevron sub-menu (aria-label "Other share").
  await page.getByLabel("Other share").click()
  const shareEntry = page.getByRole("menuitem", { name: new RegExp(`share to #?${opts.channelName}`, "i") })
  await expect(shareEntry).toBeVisible()
  await shareEntry.click()

  const composer = page.locator("[contenteditable='true']").first()
  await expect(composer).toBeVisible()
  await expect(composer.locator("[data-type='shared-message']")).toHaveCount(1)
  await composer.focus()
  await page.keyboard.press("Enter")

  // Wait for the pointer card to land hydrated with the original source
  // text. The follow-up edit/delete tests use this as the baseline before
  // observing the pointer update.
  await expect(
    page.locator("[data-type='shared-message']").filter({ hasText: new RegExp(opts.threadText) })
  ).toBeVisible({ timeout: 5000 })

  const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
  expect(match).toBeTruthy()
  const [, workspaceId, channelStreamId] = match!
  return { workspaceId, channelStreamId, threadMessageId }
}

test.describe("Message share-to-parent", () => {
  let testId: string

  test.beforeEach(async ({ page }) => {
    const result = await loginAndCreateWorkspace(page, "share-to-parent")
    testId = result.testId
  })

  test("shares a thread message up to its parent channel", async ({ page }) => {
    const channelName = `share-${testId}`
    const threadText = `thread-reply-${testId}`
    await setUpSharedPointer(page, { channelName, threadText })
    // setUpSharedPointer already asserts the hydrated pointer card is
    // visible. Nothing more to check on the happy path.
  })

  test("propagates source edits to the pointer", async ({ page }) => {
    const channelName = `share-${testId}`
    const threadText = `thread-reply-${testId}`
    const { workspaceId, threadMessageId } = await setUpSharedPointer(page, { channelName, threadText })

    // Edit the source thread message via the messages API. The backend's
    // outbox handler emits `pointer:invalidated` to the channel's room,
    // the frontend stream-sync invalidates bootstrap, and the provider
    // re-renders the pointer with the new content.
    const editedText = `edited-thread-reply-${testId}`
    const editResponse = await page.request.patch(`/api/workspaces/${workspaceId}/messages/${threadMessageId}`, {
      data: {
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: editedText }] }],
        },
        contentMarkdown: editedText,
      },
    })
    await expectApiOk(editResponse, `Edit thread message ${threadMessageId}`)

    // 10s is generous: the realtime fan-out + invalidation + bootstrap
    // refetch usually completes within a couple of seconds, but CI can
    // be slow under load.
    await expect(page.locator("[data-type='shared-message']").filter({ hasText: new RegExp(editedText) })).toBeVisible({
      timeout: 10000,
    })
  })

  test("renders a tombstone when the source message is deleted", async ({ page }) => {
    const channelName = `share-${testId}`
    const threadText = `thread-reply-${testId}`
    const { workspaceId, threadMessageId } = await setUpSharedPointer(page, { channelName, threadText })

    // Soft-delete the source thread message via the messages API. Same
    // invalidation path as the edit case; hydration now emits a
    // `state: "deleted"` payload, which the NodeView renders as the
    // muted "Message deleted by author" tombstone.
    const deleteResponse = await page.request.delete(`/api/workspaces/${workspaceId}/messages/${threadMessageId}`)
    await expectApiOk(deleteResponse, `Delete thread message ${threadMessageId}`)

    await expect(
      page.locator("[data-type='shared-message']").filter({ hasText: /Message deleted by author/i })
    ).toBeVisible({ timeout: 10000 })
  })
})
