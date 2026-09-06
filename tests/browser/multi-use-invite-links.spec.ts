import { expect, test, type Browser, type Page } from "@playwright/test"
import { expectApiOk, generateTestId, waitForWorkspaceProvisioned } from "./helpers"

async function createWorkspace(page: Page, testId: string) {
  const email = `owner-${testId}@example.com`
  await expectApiOk(
    await page.request.post("/api/dev/login", { data: { email, name: `Owner ${testId}` } }),
    "Owner login"
  )
  const response = await page.request.post("/api/workspaces", { data: { name: `Invite links ${testId}` } })
  await expectApiOk(response, "Workspace creation")
  const { workspace } = (await response.json()) as { workspace: { id: string; name: string } }
  await waitForWorkspaceProvisioned(page, workspace.id)
  return workspace
}

async function openCreateLink(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}?ws-settings=users`)
  await page.getByRole("button", { name: "Invite", exact: true }).click()
  await page.getByRole("menuitem", { name: "Create invite link" }).click()
  await expect(page).toHaveURL(/invite-link=create/)
  await expect(page.getByRole("heading", { name: "Create invite link" })).toBeVisible()
}

async function createLinkFromSettings(page: Page, workspaceId: string, maxUses: number | null, neverExpires: boolean) {
  await openCreateLink(page, workspaceId)

  if (maxUses === null) {
    await page.getByRole("switch", { name: "Unlimited" }).click()
  } else {
    await page.getByLabel("Maximum joins").fill(String(maxUses))
  }
  if (neverExpires) await page.getByRole("switch", { name: "Never expires" }).click()

  await page.getByRole("button", { name: "Create link" }).click()
  const shareLink = page.getByLabel("Share link")
  await expect(shareLink).toBeVisible()
  const url = await shareLink.inputValue()
  await page.getByRole("button", { name: "Done" }).click()
  return url
}

async function claimSignInAndAccept(
  browser: Browser,
  link: string,
  email: string,
  name: string,
  workspaceId: string,
  mobile = false
) {
  const context = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, isMobile: true } : undefined
  )
  const page = await context.newPage()
  try {
    await page.goto(link)
    await page.getByLabel("Email").fill(email)
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible()

    await expectApiOk(await page.request.post("/api/dev/login", { data: { email, name } }), `${name} login`)
    await page.goto("/workspaces")
    const accept = page.getByRole("button", { name: "Accept" })
    await expect(accept).toBeVisible({ timeout: 15_000 })
    await accept.click()
    await page.waitForURL(`**/w/${workspaceId}/setup`, { timeout: 15_000 })

    const displayName = page.getByLabel("Display name")
    await expect(displayName).toBeVisible()
    if (!(await displayName.inputValue()).trim()) await displayName.fill(name)
    const complete = page.getByRole("button", { name: "Complete Setup" })
    if (!(await complete.isEnabled())) {
      await displayName.fill(name)
      await page.getByLabel("Display slug").fill("")
    }
    await expect(complete).toBeEnabled({ timeout: 15_000 })
    await complete.click()
    await page.waitForURL((url) => url.pathname.startsWith(`/w/${workspaceId}`) && !url.pathname.endsWith("/setup"), {
      timeout: 15_000,
    })
  } finally {
    await context.close()
  }
}

async function waitForUsage(page: Page, workspaceId: string, expected: string) {
  await page.goto(`/w/${workspaceId}?ws-settings=users`)
  await expect(page.getByText(expected)).toBeVisible({ timeout: 15_000 })
}

test.describe("Multi-use invite links", () => {
  test("should create, exhaust, edit, reuse, and revoke one link on desktop", async ({ page, browser }) => {
    test.setTimeout(180_000)
    const testId = generateTestId()
    const workspace = await createWorkspace(page, testId)

    await page.goto(`/w/${workspace.id}`)
    await openCreateLink(page, workspace.id)
    await page.getByRole("button", { name: "Cancel" }).click()
    await expect(page).not.toHaveURL(/invite-link=/)
    await page.keyboard.press("Escape")
    await expect(page).not.toHaveURL(/ws-settings=/)
    await page.goBack()
    await expect(page).not.toHaveURL(/invite-link=|ws-settings=/)
    await expect(page.getByRole("heading", { name: "Create invite link" })).not.toBeVisible()
    await expect(page.getByRole("heading", { name: "Workspace Settings" })).not.toBeVisible()

    const link = await createLinkFromSettings(page, workspace.id, 2, true)

    const firstName = `First ${testId}`
    await claimSignInAndAccept(browser, link, `first-${testId}@example.com`, firstName, workspace.id)
    await page.goto(`/w/${workspace.id}?ws-settings=users`)
    const firstMemberRow = page.getByText(firstName, { exact: true }).locator("xpath=../../..").first()
    await firstMemberRow.getByRole("combobox").click()
    await page.getByRole("option", { name: "Admin" }).click()
    await expect(firstMemberRow.getByRole("combobox")).toContainText("Admin")

    await claimSignInAndAccept(browser, link, `second-${testId}@example.com`, `Second ${testId}`, workspace.id)
    await waitForUsage(page, workspace.id, "2 of 2 joined · Never expires")
    await expect(page.getByText("Exhausted")).toBeVisible()

    const exhaustedContext = await browser.newContext()
    const exhaustedPage = await exhaustedContext.newPage()
    const joinPath = new URL(link).pathname
    const token = joinPath.split("/").at(-1)!
    await expect
      .poll(
        async () => {
          const response = await exhaustedPage.request.get(`/api/invitations/lookup?token=${encodeURIComponent(token)}`)
          const body = (await response.json()) as { code?: string }
          return { status: response.status(), code: body.code }
        },
        { timeout: 15_000 }
      )
      .toEqual({ status: 409, code: "INVITATION_EXHAUSTED" })
    await exhaustedPage.goto(joinPath)
    await expect(exhaustedPage.getByRole("heading", { name: "Invitation link is full" })).toBeVisible()
    await exhaustedContext.close()

    const row = page.getByText("2 of 2 joined · Never expires").locator("xpath=../..")
    await row.getByRole("button", { name: "Edit" }).click()
    await page.getByRole("switch", { name: "Unlimited" }).click()
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.getByText("2 of unlimited joined · Never expires")).toBeVisible()
    await page.reload()
    await expect(page.getByText("2 of unlimited joined · Never expires")).toBeVisible()

    await claimSignInAndAccept(browser, link, `third-${testId}@example.com`, `Third ${testId}`, workspace.id)
    await waitForUsage(page, workspace.id, "3 of unlimited joined · Never expires")
    await page
      .getByText("3 of unlimited joined · Never expires")
      .locator("xpath=../..")
      .getByRole("button", { name: "Revoke" })
      .click()

    const revokedContext = await browser.newContext()
    const revokedPage = await revokedContext.newPage()
    await expect
      .poll(
        async () => {
          const response = await revokedPage.request.get(`/api/invitations/lookup?token=${encodeURIComponent(token)}`)
          const body = (await response.json()) as { code?: string }
          return { status: response.status(), code: body.code }
        },
        { timeout: 15_000 }
      )
      .toEqual({ status: 409, code: "INVITATION_REVOKED" })
    await revokedPage.goto(joinPath)
    await expect(revokedPage.getByRole("heading", { name: "Invitation revoked" })).toBeVisible()
    await revokedContext.close()

    await page.reload()
    await expect(page.getByRole("heading", { name: "Invite links" })).not.toBeVisible()
  })

  test("should create and accept an unlimited link on mobile", async ({ browser }) => {
    test.setTimeout(90_000)
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
    const page = await context.newPage()
    try {
      const testId = generateTestId()
      const workspace = await createWorkspace(page, testId)

      await openCreateLink(page, workspace.id)
      await page.goBack()
      await expect(page).not.toHaveURL(/invite-link=/)
      await expect(page).toHaveURL(/ws-settings=users/)
      await expect(page.getByRole("heading", { name: "Workspace Settings" })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Create invite link" })).not.toBeVisible()

      const link = await createLinkFromSettings(page, workspace.id, null, true)
      await claimSignInAndAccept(browser, link, `mobile-${testId}@example.com`, `Mobile ${testId}`, workspace.id, true)
      await waitForUsage(page, workspace.id, "1 of unlimited joined · Never expires")
    } finally {
      await context.close()
    }
  })
})
