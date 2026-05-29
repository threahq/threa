import { expect, type Page, type Browser, type BrowserContext, type APIResponse, type Locator } from "@playwright/test"

/**
 * Shared helpers for browser E2E tests.
 *
 * Every test creates a unique user + workspace for full isolation,
 * enabling parallel execution across workers without DB conflicts.
 */

/**
 * Assert API requests succeed with actionable error details.
 */
export async function expectApiOk(response: APIResponse, action: string): Promise<void> {
  if (response.ok()) {
    return
  }

  const body = await response.text().catch(() => "<failed to read response body>")
  throw new Error(`${action} failed: ${response.status()} ${response.statusText()} - ${body}`)
}

/**
 * Login using the test-only stub auth API route.
 * Faster and less flaky than driving the UI login form for every test.
 */
async function devLogin(page: Page, email: string, name: string): Promise<void> {
  const loginResponse = await page.request.post("/api/dev/login", {
    data: { email, name },
  })
  await expectApiOk(loginResponse, "Stub auth login")
}

/**
 * Generate a unique test ID combining timestamp and random suffix.
 * Safe for parallel workers that might load at the same millisecond.
 */
export function generateTestId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}

/**
 * Login as a new unique user and create a workspace.
 * Uses test-only API routes for speed; equivalent auth + workspace state
 * is created without UI form interactions.
 */
export async function loginAndCreateWorkspace(
  page: Page,
  prefix: string
): Promise<{ testId: string; email: string; name: string; workspaceName: string }> {
  const testId = generateTestId()
  const email = `${prefix}-${testId}@example.com`
  const name = `${prefix} ${testId}`
  const workspaceName = `${prefix} WS ${testId}`

  await devLogin(page, email, name)

  const createWorkspaceResponse = await page.request.post("/api/workspaces", {
    data: { name: workspaceName },
  })
  await expectApiOk(createWorkspaceResponse, "Workspace creation")
  const createWorkspaceBody = (await createWorkspaceResponse.json()) as { workspace?: { id?: string } }
  const workspaceId = createWorkspaceBody.workspace?.id
  if (!workspaceId) {
    throw new Error("Workspace creation response is missing workspace.id")
  }

  await waitForWorkspaceProvisioned(page, workspaceId)
  await setAllSidebarPreset(page, workspaceId)
  await page.goto(`/w/${workspaceId}`)
  await expect(page.getByRole("button", { name: "+ New Scratchpad" })).toBeVisible({ timeout: 10000 })

  return { testId, email, name, workspaceName }
}

/**
 * Pin the type-based ("All") sidebar layout for a workspace+viewer.
 *
 * The product default is the "Smart" preset (urgency buckets: Important / Recent
 * / Pinned / Everything Else), where a brand-new channel with no activity lands
 * in the collapsed "Everything Else" bucket and isn't visible in the sidebar.
 * The E2E suite navigates via the always-open Channels / Scratchpads / DMs
 * sections, so it pins the deterministic All preset at setup. Smart-bucket
 * resolution has its own unit coverage (`resolve-sections.test.ts`).
 *
 * Body mirrors `ALL_SIDEBAR_CONFIG` in `@threa/types` (not importable from the
 * repo-root test runtime); `quickLinks` is omitted because the PATCH schema
 * defaults + normalizes it to the full set. The backend Zod schema rejects any
 * drift loudly, so a stale literal fails fast rather than silently.
 */
async function setAllSidebarPreset(page: Page, workspaceId: string): Promise<void> {
  const response = await page.request.patch(`/api/workspaces/${workspaceId}/sidebar-config`, {
    data: {
      basePreset: "all",
      sections: [
        { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
        { id: "channels", spec: { kind: "type", streamType: "channel" } },
        { id: "dms", spec: { kind: "type", streamType: "dm" } },
      ],
    },
  })
  await expectApiOk(response, "Set All sidebar preset")
}

/** Extract the workspace id from the current `/w/:workspaceId/...` URL. */
function workspaceIdFromUrl(page: Page): string {
  const match = page.url().match(/\/w\/([^/?]+)/)
  if (!match) throw new Error(`Could not extract workspaceId from URL: ${page.url()}`)
  return match[1]
}

/**
 * Login as a new user in a separate browser context.
 * Uses test-only API route so tests can navigate directly to target pages.
 */
export async function loginInNewContext(
  browser: Browser,
  email: string,
  name: string
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()

  await devLogin(page, email, name)

  return { context, page }
}

/**
 * Ensure the sidebar shows the type-based Channels/Scratchpads/DMs sections.
 *
 * The old Smart/All view toggle is gone — the layout is now driven by the
 * persisted sidebar config (see {@link setAllSidebarPreset}). Workspaces created
 * via {@link loginAndCreateWorkspace} already pin the All preset, so for the
 * creator this is a cheap wait once any stream exists. A second user context
 * that joined a workspace mid-test is still on the default Smart preset, so we
 * persist the All preset for that viewer and reload to repaint from it.
 */
export async function switchToAllView(page: Page): Promise<void> {
  const channelsHeading = page.getByRole("heading", { name: "Channels", level: 3 })
  const alreadyAllView = await channelsHeading
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (alreadyAllView) return

  await setAllSidebarPreset(page, workspaceIdFromUrl(page))
  await page.reload()
  await expect(channelsHeading).toBeVisible({ timeout: 10000 })
}

/**
 * Wait for a workspace to be provisioned on the regional backend.
 * After the control-plane creates a workspace, the outbox asynchronously
 * provisions it in the regional backend. Poll until a workspace-scoped
 * request succeeds (the router resolves the region and the backend has data).
 */
export async function waitForWorkspaceProvisioned(page: Page, workspaceId: string): Promise<void> {
  await expect
    .poll(async () => (await page.request.get(`/api/workspaces/${workspaceId}`)).ok(), {
      message: `Workspace ${workspaceId} not provisioned on regional backend within timeout`,
      timeout: 10000,
      intervals: [100, 200, 500, 1000],
    })
    .toBe(true)
}

/**
 * Mirrors the frontend's createDmDraftId so E2E tests reference the same route shape
 * without duplicating the raw string literal at call sites.
 */
export function createDmDraftId(userId: string): string {
  return `draft_dm_${userId}`
}

/**
 * Create a new scratchpad from the sidebar when the workspace already has streams.
 *
 * The big "+ New Scratchpad" button only renders in the empty state (a brand-new
 * workspace with no streams). Once any stream exists, the Scratchpads section header
 * exposes a "New scratchpad…" menu trigger whose dropdown carries the New Scratchpad /
 * Quick Note / Encrypted Scratchpad actions — so tests that already created a channel
 * must go through the menu, not the empty-state button.
 */
export async function createScratchpadFromSidebar(page: Page): Promise<void> {
  await switchToAllView(page)
  const addButton = page.getByRole("button", { name: /New scratchpad/i })
  await expect(addButton).toBeVisible({ timeout: 10000 })
  await addButton.click()
  await page.getByRole("menuitem", { name: "New Scratchpad", exact: true }).click()
  await expect(page.getByText(/Type a message|No messages yet|Start a conversation/).first()).toBeVisible({
    timeout: 10000,
  })
}

/**
 * Create a channel via the create channel modal and wait for it to load.
 * By default switches to "All" view after creation so the channel appears in sidebar.
 */
export async function createChannel(
  page: Page,
  channelName: string,
  options?: { switchToAll?: boolean }
): Promise<void> {
  const shouldSwitchToAll = options?.switchToAll ?? true
  await page.getByRole("button", { name: "+ New Channel" }).click()
  await page.getByRole("dialog").getByPlaceholder("channel-name").fill(channelName)
  const createButton = page.getByRole("dialog").getByRole("button", { name: "Create Channel" })
  await expect(createButton).toBeEnabled({ timeout: 5000 })
  await createButton.click()
  await expect(page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({ timeout: 5000 })
  if (shouldSwitchToAll) {
    await switchToAllView(page)
    await expect(page.getByRole("link", { name: `#${channelName}` })).toBeVisible({ timeout: 5000 })
  }
}

/**
 * Return the composer used inside the thread panel.
 */
export function getPanelEditor(page: Page): Locator {
  return page.locator("[data-editor-zone='panel'] [contenteditable='true']")
}

/**
 * Send a reply through the currently visible thread panel composer.
 */
export async function sendPanelReply(page: Page, text: string): Promise<void> {
  const panel = page.getByTestId("panel")
  const editor = getPanelEditor(page)
  const sendButton = panel.getByRole("button", { name: /^(Send|Reply)$/ })

  await expect(editor).toBeVisible({ timeout: 15000 })
  await expect
    .poll(
      async () => {
        await editor.click().catch(() => {})
        await editor.press("ControlOrMeta+a").catch(() => {})
        await page.keyboard.press("Backspace").catch(() => {})
        await page.keyboard.type(text).catch(() => {})

        const editorText = await editor.textContent().catch(() => "")
        const hasText = editorText?.includes(text) ?? false
        const canSend = await sendButton.isEnabled().catch(() => false)
        if (!hasText || !canSend) return false

        return await sendButton
          .click({ timeout: 2000 })
          .then(() => true)
          .catch(() => false)
      },
      { timeout: 20000, intervals: [100, 250, 500, 1000], message: "panel editor should accept and send reply text" }
    )
    .toBe(true)
}

/**
 * Wait for a draft thread panel to settle into a real thread panel, retrying a
 * transient failed send if the UI exposes the Retry action while under load.
 */
export async function waitForRealThreadPanel(page: Page): Promise<void> {
  const panel = page.getByTestId("panel")
  const sendButton = panel.getByRole("button", { name: /^(Send|Reply)$/ })
  const retryButton = panel.getByRole("button", { name: "Retry" })
  const deadline = Date.now() + 30000

  while (Date.now() < deadline) {
    if (await retryButton.isVisible().catch(() => false)) {
      await retryButton.click()
      await page.waitForTimeout(250)
    }

    const hasDraftIntro = await page
      .getByText(/Start a new thread/)
      .isVisible()
      .catch(() => false)
    // URLSearchParams.toString() encodes the `:` in "draft:streamId:msgId" as
    // %3A, so read the decoded value via searchParams rather than matching the
    // raw URL with a regex.
    const panelId = new URL(page.url()).searchParams.get("panel")
    const isDraftPanel = panelId?.startsWith("draft:") ?? false
    const hasSendButton = await sendButton.isVisible().catch(() => false)

    if (!hasDraftIntro && !isDraftPanel && hasSendButton) {
      return
    }

    await page.waitForTimeout(250)
  }

  await expect(page.getByText(/Start a new thread/)).not.toBeVisible({ timeout: 5000 })
  await expect
    .poll(() => new URL(page.url()).searchParams.get("panel")?.startsWith("draft:") ?? false, { timeout: 5000 })
    .toBe(false)
  await expect(sendButton).toBeVisible({ timeout: 5000 })
}

/**
 * Open the thread-reply action for a message, retrying if the row exposes a
 * transient failed-send state before the reply affordance appears.
 */
export async function clickReplyInThread(messageContainer: Locator, timeout = 45000): Promise<void> {
  const replyLink = messageContainer.getByRole("link", { name: "Reply in thread" })
  const retryButton = messageContainer.getByRole("button", { name: "Retry" })

  await expect(messageContainer).toBeVisible({ timeout })
  await expect
    .poll(
      async () => {
        await messageContainer.scrollIntoViewIfNeeded().catch(() => {})
        await messageContainer.hover().catch(() => {})

        if (await retryButton.isVisible().catch(() => false)) {
          await retryButton.click()
          await messageContainer.page().waitForTimeout(250)
        }

        return await replyLink.isVisible().catch(() => false)
      },
      {
        timeout,
        intervals: [100, 250, 500, 1000],
        message: "should expose the thread-reply action for the target message",
      }
    )
    .toBe(true)

  await replyLink.click({ timeout: 10000 })
}

interface EditorShortcutOptions {
  shift?: boolean
  alt?: boolean
}

/**
 * Dispatch a formatting shortcut directly on the contenteditable surface.
 *
 * Headless Chromium can consume browser-reserved Cmd/Ctrl accelerators before they
 * reach the app, so editor shortcut tests should target the editor DOM node itself.
 */
export async function pressEditorShortcut(
  editor: Locator,
  key: string,
  options: EditorShortcutOptions = {}
): Promise<void> {
  await editor.evaluate(
    (element, { key, options }) => {
      const target = element as HTMLElement
      target.focus()

      const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      const normalizedKey = key.length === 1 ? key.toLowerCase() : key
      const shiftedKey = options.shift && key.length === 1 ? normalizedKey.toUpperCase() : normalizedKey
      const code =
        normalizedKey.length === 1 && /^[a-z]$/i.test(normalizedKey) ? `Key${normalizedKey.toUpperCase()}` : undefined
      const keyCode =
        normalizedKey.length === 1 && /^[a-z]$/i.test(normalizedKey) ? normalizedKey.toUpperCase().charCodeAt(0) : 0

      for (const type of ["keydown", "keyup"] as const) {
        const event = new KeyboardEvent(type, {
          key: shiftedKey,
          code,
          bubbles: true,
          cancelable: true,
          composed: true,
          metaKey: isMac,
          ctrlKey: !isMac,
          shiftKey: !!options.shift,
          altKey: !!options.alt,
        })
        Object.defineProperty(event, "keyCode", { get: () => keyCode })
        Object.defineProperty(event, "which", { get: () => keyCode })
        Object.defineProperty(event, "charCode", { get: () => keyCode })
        target.dispatchEvent(event)
      }
    },
    { key, options }
  )
}

/**
 * Select all editor contents directly in the DOM selection.
 */
export async function selectAllEditorContent(editor: Locator): Promise<void> {
  await editor.evaluate((element) => {
    const target = element as HTMLElement
    const selection = target.ownerDocument.getSelection()
    if (!selection) {
      throw new Error("Editor selection is unavailable")
    }

    target.focus()
    const range = target.ownerDocument.createRange()
    range.selectNodeContents(target)
    selection.removeAllRanges()
    selection.addRange(range)
  })
}
