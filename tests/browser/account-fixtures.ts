import { expect, type Page } from "@playwright/test"
import {
  currentAccount,
  devLogin,
  expectApiOk,
  loginAndCreateWorkspace,
  switchToAllView,
  waitForWorkspaceProvisioned,
  type DevLoginUser,
} from "./helpers"

/**
 * The two-account browser fixture: one workspace, both accounts signed in to one
 * browser context, each with a private scratchpad only they can read, and the
 * real account picker as the way between them. Shared by every spec that has to
 * watch one account's state under another (`account-switch`,
 * `account-storage-isolation`) — a second copy of this setup would be a second
 * definition of what "switched" means.
 */

export interface AccountFixture {
  user: DevLoginUser
  /** The account's name inside the workspace (`users.name`), which the picker prefers. */
  profileName: string
  scratchpadId: string
  scratchpadName: string
  message: string
}

export interface SharedWorkspace {
  workspaceId: string
  a: AccountFixture
  b: AccountFixture
}

export function workspaceIdFrom(page: Page): string {
  const match = page.url().match(/\/w\/([^/?]+)/)
  if (!match) throw new Error(`Could not extract workspaceId from URL: ${page.url()}`)
  return match[1]
}

async function createPrivateScratchpad(page: Page, workspaceId: string, displayName: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "scratchpad", displayName, visibility: "private" },
  })
  await expectApiOk(response, `Create scratchpad ${displayName}`)
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

export async function postMessage(page: Page, workspaceId: string, streamId: string, content: string): Promise<void> {
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
export async function setUpSharedWorkspace(page: Page): Promise<SharedWorkspace> {
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
  // The stub add swaps the browser's active account through the API, behind the
  // open page. The real callback returns the browser to this URL, so follow it
  // here: a page left running on the parked account keeps forming requests for
  // it, and the server now refuses those (409 ACCOUNT_MISMATCH).
  await page.goto("/workspaces?accountAdded=1")
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
 * Open the account picker from the sidebar footer (dropdown on mouse, drawer on
 * touch), with the dialog's own accounts list loaded.
 *
 * The accounts query does not retry (`makeQueryClient` sets `retry: false`), so
 * a fetch the page aborted mid-navigation leaves the dialog on its "Close and
 * try again" state. Do exactly that rather than reading a transient abort as a
 * missing account.
 */
export async function openAccountPicker(page: Page, currentProfileName: string): Promise<void> {
  const sidebar = page.getByRole("navigation", { name: "Sidebar navigation" })
  const dialog = page.getByRole("dialog").filter({ has: page.getByText("Switch account") })
  const loadFailed = dialog.getByText(/Couldn.t load your accounts/)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const accountButton = sidebar.getByRole("button").filter({ hasText: currentProfileName }).first()
    await expect(accountButton).toBeVisible({ timeout: 20_000 })
    await accountButton.click()

    const switchEntry = page
      .getByRole("menuitem", { name: "Switch account" })
      .or(page.getByRole("button", { name: "Switch account" }))
      .first()
    await expect(switchEntry).toBeVisible({ timeout: 10_000 })
    await switchEntry.click()
    await expect(dialog).toBeVisible({ timeout: 15_000 })

    await expect(dialog.getByLabel("Current account").or(loadFailed)).toBeVisible({ timeout: 15_000 })
    if (!(await loadFailed.isVisible())) return
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0, { timeout: 10_000 })
  }
  throw new Error("The account picker never loaded this browser's accounts")
}

/** Click the picker row for `email` and wait for the picker to close. */
export async function pickAccount(page: Page, email: string): Promise<void> {
  const dialog = page.getByRole("dialog").filter({ has: page.getByText("Switch account") })
  const row = dialog.getByRole("button").filter({ hasText: email }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(dialog).toHaveCount(0, { timeout: 20_000 })
}
