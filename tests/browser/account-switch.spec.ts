import { test, expect, type Page } from "@playwright/test"
import {
  devLogin,
  expectApiOk,
  loginAndCreateWorkspace,
  switchToAllView,
  waitForWorkspaceProvisioned,
  type DevLoginUser,
} from "./helpers"

/**
 * Two accounts signed in to one browser context, both members of the same
 * workspace, each with a private scratchpad only they can read.
 *
 * The switch is driven through the real picker (sidebar account menu ->
 * "Switch account" -> the account row), so it exercises the production
 * `/api/accounts/switch` + `AccountScopeProvider` lifecycle rather than a
 * fixture that flips state behind the UI. What the assertions protect: the
 * destination account's identity, sidebar, stream content and landing
 * destination all change together, and the outgoing account's private
 * scratchpad and messages never appear under the account that switched in.
 */

test.describe.configure({ timeout: 240_000 })

const PHONE = { width: 390, height: 780 }

interface AccountFixture {
  user: DevLoginUser
  /** The account's name inside the workspace (`users.name`), which the picker prefers. */
  profileName: string
  scratchpadId: string
  scratchpadName: string
  message: string
}

interface SharedWorkspace {
  workspaceId: string
  a: AccountFixture
  b: AccountFixture
}

function workspaceIdFrom(page: Page): string {
  const match = page.url().match(/\/w\/([^/?]+)/)
  if (!match) throw new Error(`Could not extract workspaceId from URL: ${page.url()}`)
  return match[1]
}

async function currentAccount(page: Page): Promise<DevLoginUser> {
  const response = await page.request.get("/api/auth/me")
  await expectApiOk(response, "Read active account")
  return (await response.json()) as DevLoginUser
}

async function createPrivateScratchpad(page: Page, workspaceId: string, displayName: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "scratchpad", displayName, visibility: "private" },
  })
  await expectApiOk(response, `Create scratchpad ${displayName}`)
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function postMessage(page: Page, workspaceId: string, streamId: string, content: string): Promise<void> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, content },
  })
  await expectApiOk(response, "Send message")
}

/** Accept the workspace invitation waiting for the signed-in account. */
async function acceptInvitation(page: Page, workspaceId: string): Promise<void> {
  let invitationId: string | null = null
  // The invitation reaches the control plane through the regional outbox, so
  // it shows up a moment after the invite call returns.
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/workspaces")
        if (!response.ok()) return null
        const body = (await response.json()) as { pendingInvitations?: Array<{ id: string; workspaceId: string }> }
        invitationId = body.pendingInvitations?.find((invite) => invite.workspaceId === workspaceId)?.id ?? null
        return invitationId
      },
      { message: "Invitation never reached the control plane", timeout: 30_000, intervals: [200, 500, 1000] }
    )
    .not.toBeNull()

  await expectApiOk(await page.request.post(`/api/invitations/${invitationId}/accept`), "Accept workspace invitation")
  await waitForWorkspaceProvisioned(page, workspaceId)
}

/**
 * Account A creates the workspace and a private scratchpad; account B is added
 * to the same browser context through the stub auth add-account path (which
 * parks A exactly as the OAuth callback does), accepts A's invitation, and gets
 * a private scratchpad of its own. Ends with B active, landed in the workspace,
 * because an add makes the added account the active one.
 */
async function setUpSharedWorkspace(page: Page): Promise<SharedWorkspace> {
  const { testId } = await loginAndCreateWorkspace(page, "acct-a")
  const workspaceId = workspaceIdFrom(page)

  const userA = await currentAccount(page)
  const scratchpadNameA = `a-private-${testId}`
  const scratchpadA = await createPrivateScratchpad(page, workspaceId, scratchpadNameA)
  const messageA = `A only ${testId}`
  await postMessage(page, workspaceId, scratchpadA, messageA)

  const emailB = `acct-b-${testId}@example.com`
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/invitations`, {
      data: { emails: [emailB], role: "member" },
    }),
    "Invite account B"
  )

  const userB = await devLogin(page, emailB, `B WorkOS ${testId}`, { intent: "add" })
  await acceptInvitation(page, workspaceId)
  // The WorkOS name and the workspace profile name differ on purpose: the
  // picker must label each row from the *workspace* roster, matched on
  // workos_user_id, so a row showing the WorkOS name would be a real miss.
  const profileNameB = `B Profile ${testId}`
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/setup`, {
      data: { name: profileNameB, timezone: "UTC", locale: "en-US" },
    }),
    "Complete account B's workspace setup"
  )
  const scratchpadNameB = `b-private-${testId}`
  const scratchpadB = await createPrivateScratchpad(page, workspaceId, scratchpadNameB)
  const messageB = `B only ${testId}`
  await postMessage(page, workspaceId, scratchpadB, messageB)

  // The add-account return the control plane actually sends the browser to.
  // The last-active pointer in this browser still names A, so this boot is the
  // one that must resolve its account from the credential instead.
  await page.goto("/workspaces?accountAdded=1")
  await page.goto(`/w/${workspaceId}`)
  await switchToAllView(page)

  return {
    workspaceId,
    a: {
      user: userA,
      profileName: userA.name,
      scratchpadId: scratchpadA,
      scratchpadName: scratchpadNameA,
      message: messageA,
    },
    b: {
      user: userB,
      profileName: profileNameB,
      scratchpadId: scratchpadB,
      scratchpadName: scratchpadNameB,
      message: messageB,
    },
  }
}

/**
 * Open the phone sidebar when it is closed; a no-op once it is showing.
 *
 * Two toggles carry this label — the sidebar's own header and the open page's
 * header — and whichever belongs to an off-screen surface sits outside the
 * viewport and cannot be clicked, so pick the one actually on screen.
 */
async function ensureSidebarOpen(page: Page): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
  const collapse = nav.getByRole("button", { name: "Collapse sidebar" })
  if (await collapse.isVisible().catch(() => false)) return

  const toggles = page.getByRole("button", { name: "Pin sidebar" })
  const viewport = page.viewportSize()
  const count = await toggles.count()
  for (let i = 0; i < count; i += 1) {
    const box = await toggles.nth(i).boundingBox()
    if (!box || !viewport) continue
    if (box.x >= 0 && box.x + box.width <= viewport.width) {
      await toggles.nth(i).click()
      break
    }
  }
  await expect(collapse).toBeVisible({ timeout: 15_000 })
}

/** Open the account picker from the sidebar footer (dropdown on mouse, drawer on touch). */
async function openAccountPicker(page: Page, currentProfileName: string): Promise<void> {
  const sidebar = page.getByRole("navigation", { name: "Sidebar navigation" })
  const accountButton = sidebar.getByRole("button").filter({ hasText: currentProfileName }).first()
  await expect(accountButton).toBeVisible({ timeout: 20_000 })
  await accountButton.click()

  const switchEntry = page
    .getByRole("menuitem", { name: "Switch account" })
    .or(page.getByRole("button", { name: "Switch account" }))
    .first()
  await expect(switchEntry).toBeVisible({ timeout: 10_000 })
  await switchEntry.click()
}

/** Click the picker row for `email` and wait for the picker to close. */
async function pickAccount(page: Page, email: string): Promise<void> {
  const dialog = page.getByRole("dialog").filter({ has: page.getByText("Switch account") })
  const row = dialog.getByRole("button").filter({ hasText: email }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(dialog).toHaveCount(0, { timeout: 20_000 })
}

/**
 * The destination account owns the whole surface: its own identity in the
 * sidebar footer, its own private scratchpad in the stream list, and no trace
 * of the account that just left. Asserted on presence rather than visibility,
 * because a phone parks the sidebar off-screen while keeping it mounted.
 */
async function expectAccountOwnsWorkspace(page: Page, present: AccountFixture, absent: AccountFixture) {
  const sidebar = page.getByRole("navigation", { name: "Sidebar navigation" })
  await expect(sidebar.getByRole("button").filter({ hasText: present.profileName })).not.toHaveCount(0, {
    timeout: 30_000,
  })
  await expect(sidebar.getByRole("link", { name: present.scratchpadName })).not.toHaveCount(0, { timeout: 30_000 })
  await expect(sidebar.getByRole("button").filter({ hasText: absent.profileName })).toHaveCount(0)
  await expect(page.getByRole("link", { name: absent.scratchpadName })).toHaveCount(0)
  await expect(page.getByText(absent.message)).toHaveCount(0)
}

/**
 * The destination lands somewhere of its own inside the workspace — never left
 * on the outgoing account's stream, which that account cannot read. The
 * workspace index restores the destination's own last surface, so the exact
 * path is the destination's business, not this test's.
 */
async function expectLandedOffOutgoingStream(page: Page, workspaceId: string, outgoing: AccountFixture) {
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}(?:[/?#]|$)`), { timeout: 30_000 })
  await expect(page).not.toHaveURL(new RegExp(outgoing.scratchpadId))
}

async function openScratchpad(page: Page, account: AccountFixture) {
  await page.getByRole("link", { name: account.scratchpadName }).first().click()
  await expect(page.getByText(account.message).first()).toBeVisible({ timeout: 30_000 })
}

test.describe("Account switch — two accounts sharing a workspace", () => {
  test("an explicit switch swaps identity, sidebar and stream content, and back again", async ({ page }) => {
    const { workspaceId, a, b } = await setUpSharedWorkspace(page)

    // ─── B is active after the add, and only sees its own private scratchpad ───
    await expectAccountOwnsWorkspace(page, b, a)
    await openScratchpad(page, b)

    // ─── The picker labels each row from the workspace roster, by workos id ───
    await openAccountPicker(page, b.profileName)
    const dialog = page.getByRole("dialog").filter({ has: page.getByText("Switch account") })
    await expect(dialog.getByText(b.profileName)).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByText(a.profileName)).toBeVisible()
    await expect(dialog.getByText(b.user.name)).toHaveCount(0)

    // ─── Switch to A: lands on A's own home, under A's identity and data ───
    await pickAccount(page, a.user.email)
    await expectLandedOffOutgoingStream(page, workspaceId, b)
    await expectAccountOwnsWorkspace(page, a, b)
    await openScratchpad(page, a)

    // ─── A composes: the optimistic row carries A's authorship before the ack ───
    let releaseSend = () => {}
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    await page.route("**/api/workspaces/*/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue()
        return
      }
      await sendGate
      await route.continue()
    })

    const optimisticText = `optimistic from A ${a.scratchpadName}`
    const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
    await expect(composer).toBeVisible({ timeout: 20_000 })
    await composer.click()
    await page.keyboard.type(optimisticText)
    await page.keyboard.press("Enter")

    const optimisticRow = page.locator("[data-author-name]").filter({ hasText: optimisticText }).first()
    // The send is still held open, so this row can only be the optimistic one.
    await expect(optimisticRow).toHaveAttribute("data-author-name", a.profileName, { timeout: 20_000 })

    releaseSend()
    await expect(optimisticRow).toHaveAttribute("data-author-name", a.profileName, { timeout: 30_000 })
    await page.unroute("**/api/workspaces/*/messages")

    // ─── Switch back to B: B's own surface returns, A's is gone again ───
    await openAccountPicker(page, a.profileName)
    await pickAccount(page, b.user.email)
    await expectLandedOffOutgoingStream(page, workspaceId, a)
    await expectAccountOwnsWorkspace(page, b, a)
    await expect(page.getByText(optimisticText)).toHaveCount(0)
    await openScratchpad(page, b)
  })

  test.describe("phone", () => {
    test.use({ hasTouch: true })

    test("switching and a notification deep link both land under the right account", async ({ page }) => {
      // Setup runs at the default viewport: the workspace empty state it waits
      // on lives in the sidebar, which a phone keeps closed.
      const { workspaceId, a, b } = await setUpSharedWorkspace(page)
      await page.setViewportSize(PHONE)

      // The phone sidebar is closed until it's asked for.
      await ensureSidebarOpen(page)
      await expectAccountOwnsWorkspace(page, b, a)

      await openAccountPicker(page, b.profileName)
      await pickAccount(page, a.user.email)
      await expectLandedOffOutgoingStream(page, workspaceId, b)
      await expectAccountOwnsWorkspace(page, a, b)

      // ─── A notification for the parked account keeps its deep link and
      // switches the account under it, instead of opening it as A ───
      await page.evaluate(
        ({ url, workosUserId }) => {
          navigator.serviceWorker.dispatchEvent(
            new MessageEvent("message", { data: { type: "NOTIFICATION_CLICK", url, workosUserId } })
          )
        },
        { url: `/w/${workspaceId}/s/${b.scratchpadId}`, workosUserId: b.user.id }
      )

      await expect(page).toHaveURL(new RegExp(`/s/${b.scratchpadId}`), { timeout: 30_000 })
      await expect(page.getByText(b.message).first()).toBeVisible({ timeout: 30_000 })
      await expectAccountOwnsWorkspace(page, b, a)
    })
  })
})
