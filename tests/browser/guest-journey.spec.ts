import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { devLogin, expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"

const PHONE = { width: 390, height: 844 }

interface GuestSession {
  context: BrowserContext
  page: Page
}

async function createChannelViaApi(
  page: Page,
  workspaceId: string,
  slug: string,
  visibility: "public" | "private"
): Promise<void> {
  const res = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug, visibility },
  })
  await expectApiOk(res, `Create ${visibility} channel`)
}

async function joinAsGuest(
  browser: Browser,
  workspaceId: string,
  testId: string,
  options?: { viewport?: typeof PHONE }
): Promise<GuestSession & { name: string }> {
  const name = `Visitor ${testId}`
  const context = await browser.newContext(options?.viewport ? { viewport: options.viewport } : {})
  const page = await context.newPage()
  await devLogin(page, `visitor-${testId}@example.com`, name)
  const joinRes = await page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "guest", name } })
  await expectApiOk(joinRes, "Join workspace as guest")
  return { context, page, name }
}

async function createOpenToGuestsChannel(page: Page, slug: string): Promise<string> {
  const dialog = page.getByRole("dialog", { name: "Create a channel" })
  await dialog.getByPlaceholder("channel-name").fill(slug)
  const openToGuests = dialog.getByRole("button", { name: /^Open to guests/ })
  await openToGuests.click()
  await expect(openToGuests).toHaveAttribute("aria-pressed", "true")
  const createButton = dialog.getByRole("button", { name: "Create Channel" })
  await expect(createButton).toBeEnabled({ timeout: 5000 })
  await createButton.click()
  await expect(page.getByRole("heading", { name: `#${slug}`, level: 1 })).toBeVisible({ timeout: 10000 })
  const match = page.url().match(/\/s\/([^/?]+)/)
  if (!match) throw new Error(`Channel creation did not land on a stream URL: ${page.url()}`)
  return match[1]
}

async function joinAndPost(page: Page, slug: string, message: string): Promise<void> {
  await expect(page.getByRole("heading", { name: `#${slug}`, level: 1 })).toBeVisible({ timeout: 10000 })
  const joinButton = page.getByRole("button", { name: "Join Channel" })
  await joinButton.click()
  await expect(joinButton).toBeHidden({ timeout: 10000 })

  const editor = page.locator("[data-editor-zone='main'] [contenteditable='true']")
  // Joining swaps the composer in, and a late re-render can drop focus after the assertion; retry the step from an emptied editor.
  await expect(async () => {
    // On phones the composer card owns the tap and forwards focus to the editor.
    await page
      .locator("[data-composer-card]")
      .last()
      .click({ position: { x: 40, y: 18 } })
    await expect(editor).toBeFocused({ timeout: 2000 })
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.press("Backspace")
    await page.keyboard.type(message)
    await expect(editor).toContainText(message, { timeout: 2000 })
  }).toPass({ timeout: 15000 })
  await page.getByRole("button", { name: "Send" }).click()
  await expect(page.getByTestId("stream-timeline").getByText(message, { exact: true })).toBeVisible({
    timeout: 15000,
  })
}

function directoryRow(page: Page, slug: string): Locator {
  return page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: new RegExp(slug) }) })
    .filter({ has: page.getByRole("button", { name: "Join", exact: true }) })
}

async function horizontalOverflow(locator: Locator): Promise<number> {
  return locator.evaluate((el) => el.scrollWidth - el.clientWidth)
}

test.describe("Guest journey", () => {
  test("should keep a guest to open-to-guests channels when the owner invites and admits a guest", async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000)
    const { testId } = await loginAndCreateWorkspace(page, "g6-owner")
    const workspaceId = workspaceIdFromUrl(page)
    const guestsSlug = `g6-${testId}-guests`
    const publicSlug = `g6-${testId}-public`
    const privateSlug = `g6-${testId}-private`
    const inviteEmail = `invitee-${testId}@example.com`
    const message = `Hello from the guest ${testId}`

    await page.getByRole("button", { name: "+ New Channel" }).click()
    const streamId = await createOpenToGuestsChannel(page, guestsSlug)
    await createChannelViaApi(page, workspaceId, publicSlug, "public")
    await createChannelViaApi(page, workspaceId, privateSlug, "private")

    await page.goto(`/w/${workspaceId}?ws-settings=users`)
    const settings = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: /^Members \(/ }) })
    await settings.getByRole("button", { name: "Invite", exact: true }).click()
    await page.getByRole("menuitem", { name: "Invite by email" }).click()
    const inviteDialog = page.getByRole("dialog", { name: "Invite Users" })
    await inviteDialog.getByLabel("Email addresses").fill(inviteEmail)
    await inviteDialog.getByLabel("Role").click()
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Member", "Admin", "Guest"])
    await page.getByRole("listbox").getByRole("option", { name: "Guest" }).click()
    await inviteDialog.getByRole("button", { name: "Send Invitations" }).click()
    await expect(inviteDialog.getByText("Sent 1 invitation", { exact: true })).toBeVisible({ timeout: 10000 })
    await inviteDialog.getByRole("button", { name: "Done" }).click()
    const pendingInvitation = settings
      .locator("div")
      .filter({ hasText: inviteEmail })
      .filter({ has: page.getByText("Guest", { exact: true }) })
      .last()
    await expect(pendingInvitation).toBeVisible({ timeout: 10000 })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.getByRole("heading", { name: `#${guestsSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

    const guest = await joinAsGuest(browser, workspaceId, testId)
    try {
      await guest.page.goto(`/w/${workspaceId}`)
      const switcherTab = guest.page.getByRole("tab", { name: "Stream search" })
      await expect(async () => {
        await guest.page.keyboard.press("Meta+k")
        await expect(switcherTab).toBeVisible({ timeout: 2000 })
      }).toPass({ timeout: 20000 })
      await guest.page.keyboard.type(`g6-${testId}`)
      const switcher = guest.page.getByRole("dialog")
      await expect(switcher.getByRole("option", { name: new RegExp(guestsSlug) })).toBeVisible({ timeout: 10000 })
      await expect(switcher.getByRole("option", { name: new RegExp(publicSlug) })).toHaveCount(0)
      await expect(switcher.getByRole("option", { name: new RegExp(privateSlug) })).toHaveCount(0)
      await guest.page.keyboard.press("Escape")
      await expect(switcherTab).toBeHidden()

      await guest.page.goto(`/w/${workspaceId}/streams`)
      await expect(directoryRow(guest.page, guestsSlug)).toBeVisible({ timeout: 15000 })
      await expect(guest.page.getByRole("link", { name: new RegExp(publicSlug) })).toHaveCount(0)
      await expect(guest.page.getByRole("link", { name: new RegExp(privateSlug) })).toHaveCount(0)

      await directoryRow(guest.page, guestsSlug).getByRole("link").click()
      await joinAndPost(guest.page, guestsSlug, message)

      const guestSidebar = guest.page.getByRole("navigation", { name: "Sidebar navigation" })
      await expect(guestSidebar.getByRole("link", { name: `#${guestsSlug}` })).toBeVisible({ timeout: 10000 })
      await expect(guest.page.getByRole("button", { name: /New Channel/ })).toHaveCount(0)
      await guest.page.goto(`/w/${workspaceId}/streams?create-channel=`)
      await expect(guestSidebar.getByRole("link", { name: `#${guestsSlug}` })).toBeVisible({ timeout: 10000 })
      await expect(guest.page.getByRole("dialog", { name: "Create a channel" })).toHaveCount(0)

      await expect(async () => {
        await guest.page.keyboard.press("Meta+k")
        await expect(switcherTab).toBeVisible({ timeout: 2000 })
      }).toPass({ timeout: 20000 })
      await guest.page.keyboard.type("g6-")
      await expect(switcher.getByRole("option", { name: new RegExp(guestsSlug) })).toBeVisible({ timeout: 10000 })
      await expect(switcher.locator('a[href*="/s/draft_dm_"]')).toHaveCount(0)
      await guest.page.keyboard.press("Escape")
      await expect(switcherTab).toBeHidden()

      await expect(page.getByTestId("stream-timeline").getByText(message, { exact: true })).toBeVisible({
        timeout: 30000,
      })

      await page.getByTestId("stream-timeline").getByRole("button", { name: guest.name }).click()
      const profile = page.getByRole("dialog", { name: "Profile" })
      await expect(profile.getByText(guest.name).first()).toBeVisible()
      await expect(profile.getByRole("link", { name: "Message" })).toHaveCount(0)
      await page.keyboard.press("Escape")
      await expect(profile).toBeHidden()

      const sidebar = page.getByRole("navigation", { name: "Sidebar navigation" })
      await expect(sidebar.getByRole("link", { name: `#${guestsSlug}` }).getByLabel("Open to guests")).toBeVisible()

      await page.goto(`/w/${workspaceId}?ws-settings=users`)
      const guestRoleCell = settings
        .locator("div")
        .filter({ has: page.getByRole("button", { name: `Manage ${guest.name}` }) })
        .last()
      await expect(guestRoleCell.getByText("Guest", { exact: true })).toBeVisible({ timeout: 10000 })
      await expect(guestRoleCell.getByRole("combobox")).toHaveCount(0)
    } finally {
      await guest.context.close()
    }
  })

  test("should fit the visibility options and let a guest post when on a phone", async ({ page, browser }) => {
    test.setTimeout(120_000)
    const { testId } = await loginAndCreateWorkspace(page, "g6-phone")
    const workspaceId = workspaceIdFromUrl(page)
    const guestsSlug = `g6-${testId}-guests`
    const message = `Phone hello ${testId}`

    await page.setViewportSize(PHONE)
    // A concrete page, not the workspace index: the index's own redirect can land after the dialog navigates.
    await page.goto(`/w/${workspaceId}/streams?create-channel=`)
    const dialog = page.getByRole("dialog", { name: "Create a channel" })
    const options = {
      public: dialog.getByRole("button", { name: /^Public/ }),
      guests: dialog.getByRole("button", { name: /^Open to guests/ }),
      private: dialog.getByRole("button", { name: /^Private/ }),
    }
    await expect(options.private).toBeVisible({ timeout: 10000 })
    expect({
      public: await horizontalOverflow(options.public),
      guests: await horizontalOverflow(options.guests),
      private: await horizontalOverflow(options.private),
      dialog: await horizontalOverflow(dialog),
      page: await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    }).toEqual({ public: 0, guests: 0, private: 0, dialog: 0, page: 0 })
    for (const option of Object.values(options)) {
      const box = await option.boundingBox()
      expect(box && box.x >= 0 && box.x + box.width <= PHONE.width).toBe(true)
    }

    await createOpenToGuestsChannel(page, guestsSlug)

    const guest = await joinAsGuest(browser, workspaceId, testId, { viewport: PHONE })
    try {
      await guest.page.goto(`/w/${workspaceId}/streams`)
      await directoryRow(guest.page, guestsSlug).getByRole("link").click()
      await joinAndPost(guest.page, guestsSlug, message)
    } finally {
      await guest.context.close()
    }
  })
})
