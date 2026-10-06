import { test, expect, type Locator, type Page } from "@playwright/test"
import type { ListStreamConnectionsResponse } from "@threahq/types"
import {
  clickReplyInThread,
  enrollWorkspaceFlag,
  expectApiOk,
  getPanelEditor,
  loginAndCreateWorkspace,
  waitForRealThreadPanel,
  workspaceIdFromUrl,
  type TestRegion,
} from "./helpers"

/**
 * Sharing a channel across workspaces: the host admin mints an invite link from
 * channel settings, a partner admin opens it in another workspace's session and
 * accepts, and the host's settings then name every partner.
 */

test.describe.configure({ timeout: 90_000 })

const PHONE = { width: 390, height: 844 }

async function setUpWorkspace(page: Page, prefix: string, region?: TestRegion) {
  const created = await loginAndCreateWorkspace(page, prefix, { region })
  const workspaceId = workspaceIdFromUrl(page)
  await enrollWorkspaceFlag(page, workspaceId, "streamConnections", region)
  return { ...created, workspaceId }
}

async function setUpHostAndPartner(hostPage: Page, partnerPage: Page, partnerRegion?: TestRegion) {
  const host = await setUpWorkspace(hostPage, "host")
  const slug = `design-${host.testId}`
  const response = await hostPage.request.post(`/api/workspaces/${host.workspaceId}/streams`, {
    data: { type: "channel", slug, visibility: "public" },
  })
  await expectApiOk(response, "Create channel")
  const streamId = ((await response.json()) as { stream: { id: string } }).stream.id

  const partner = await setUpWorkspace(partnerPage, "partner", partnerRegion)

  return { host, partner, slug, streamId }
}

/** The partner's copy lands with its first pull, a moment after the accept; a page opened before then stays not-found. */
async function openPartnerCopy(page: Page, workspaceId: string, streamId: string) {
  await expect
    .poll(async () => (await page.request.get(`/api/workspaces/${workspaceId}/streams/${streamId}`)).status(), {
      timeout: 30_000,
    })
    .toBe(200)
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
}

function settingsUrl(workspaceId: string, streamId: string, tab: string): string {
  return `/w/${workspaceId}/s/${streamId}?stream-settings=${tab}&sid=${streamId}`
}

async function createInviteLink(page: Page): Promise<string> {
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Create invite link" }).click()
  const link = await dialog.getByLabel("Invite link").inputValue()
  expect(link).toMatch(/\/connections\/[^/]+$/)
  return new URL(link).pathname
}

async function acceptInvite(
  page: Page,
  invitePath: string,
  slug: string,
  hostName: string,
  partnerName: string,
  alreadyIn?: string
) {
  await page.goto(invitePath)
  await expect(page.getByRole("heading", { name: `#${slug} from ${hostName}` })).toBeVisible()
  if (alreadyIn) await expect(page.getByText(`${alreadyIn} is already in this channel.`)).toBeVisible()
  await expect(page.getByText("Hosted in Local.", { exact: false })).toBeVisible()
  await expect(page.getByRole("combobox")).toHaveText(partnerName)
  await page.getByRole("button", { name: "Accept" }).click()
  await expect(page.getByRole("heading", { name: `#${slug} is shared with ${partnerName}` })).toBeVisible()
  await expect(page.getByRole("link", { name: `Open ${partnerName}` })).toBeVisible()
}

// 1x1 red PNG
const TEST_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

async function pasteImage(page: Page) {
  await page.evaluate((bytes) => {
    const editor = document.querySelector("[data-message-composer-root] [contenteditable='true']")
    if (!editor) throw new Error("Editor not found")
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File([new Uint8Array(bytes)], "mockup.png", { type: "image/png" }))
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer }))
  }, Array.from(TEST_PNG))
}

async function sendText(page: Page, text: string) {
  const editor = page.locator("[data-message-composer-root] [contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(text)
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
  await expect(editor).toHaveText("", { timeout: 15_000 })
}

async function sendMentionOf(editor: Locator, send: Locator, query: string, person: string, text: string) {
  await editor.click()
  await editor.pressSequentially(`@${query}`)
  const option = editor
    .page()
    .getByRole("listbox", { name: "Mention suggestions" })
    .getByRole("option", { name: person })
  await expect(option).toBeVisible({ timeout: 10_000 })
  await option.click()
  await editor.pressSequentially(text)
  await send.click()
  await expect(editor).toHaveText("", { timeout: 15_000 })
}

async function expectMentionActivity(page: Page, workspaceId: string, text: string) {
  await page.goto(`/w/${workspaceId}/activity`)
  const mention = page.getByRole("main").getByRole("link").filter({ hasText: "mentioned you in" })
  await expect(mention.getByText(text)).toBeVisible({ timeout: 30_000 })
}

function timelineMessage(page: Page, text: string) {
  return page.getByRole("main").locator(".message-item").filter({ hasText: text }).first()
}

async function editMessage(page: Page, message: Locator, text: string) {
  await message.hover()
  await message.getByRole("button", { name: "Message actions" }).click()
  await page.getByRole("menuitem", { name: "Edit message" }).click()
  const editor = page.locator("[data-inline-edit] [contenteditable='true']")
  await editor.click()
  await editor.press("ControlOrMeta+a")
  await editor.pressSequentially(text)
  await page.getByRole("main").getByRole("button", { name: "Save", exact: true }).click()
  // A copy's edit saves through the host; the form, still showing the new text, collapses only once it lands.
  await expect(page.locator("[data-inline-edit]")).toHaveCount(0, { timeout: 15_000 })
}

async function deleteMessage(page: Page, message: Locator) {
  await message.hover()
  await message.getByRole("button", { name: "Message actions" }).click()
  await page.getByRole("menuitem", { name: "Delete message" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
}

async function reactToMessage(page: Page, message: Locator): Promise<string> {
  await message.hover()
  await message.getByRole("button", { name: "Add reaction" }).first().click()
  const option = page.locator("[role='listbox']").last().locator("button[role='option']").first()
  await expect(option).toBeVisible({ timeout: 5000 })
  const emoji = (await option.textContent())?.trim()
  if (!emoji) throw new Error("First emoji option rendered without visible emoji content")
  await option.click()
  return emoji
}

async function expectSharedWith(page: Page, partnerNames: string[]) {
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Shared with")).toBeVisible({ timeout: 10000 })
  for (const name of partnerNames) await expect(dialog.getByText(name)).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Create invite link" })).toBeVisible()
  await expect(dialog.getByRole("alert")).toHaveCount(0)
}

test.describe("Stream connections", () => {
  test("should share a channel with another workspace when its admin accepts, and name it in the host's open settings", async ({
    browser,
    page,
  }) => {
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage)

      await page.goto(settingsUrl(host.workspaceId, streamId, "general"))
      await page
        .locator('[data-slot="settings-nav"]')
        .getByRole("button", { name: /Connect/ })
        .click()
      const invitePath = await createInviteLink(page)

      await acceptInvite(partnerPage, invitePath, slug, host.workspaceName, partner.workspaceName)
      await expectSharedWith(page, [partner.workspaceName])
    } finally {
      await partnerContext.close()
    }
  })

  test("should name the other workspace in the channel header for a host member and a partner member when the channel is shared", async ({
    browser,
    page,
  }) => {
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage)
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)

      await page.goto(`/w/${host.workspaceId}/s/${streamId}`)
      await expect(page.getByText(`Shared with ${partner.workspaceName}`, { exact: true })).toBeVisible({
        timeout: 15_000,
      })
      await openPartnerCopy(partnerPage, partner.workspaceId, streamId)
      await expect(partnerPage.getByText(`Shared with ${host.workspaceName}`, { exact: true })).toBeVisible({
        timeout: 30_000,
      })
    } finally {
      await partnerContext.close()
    }
  })

  test("should share a channel with a workspace in another region when its admin accepts", async ({
    browser,
    page,
  }) => {
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage, "local-2")

      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      const invitePath = await createInviteLink(page)

      await acceptInvite(partnerPage, invitePath, slug, host.workspaceName, partner.workspaceName)
      await expectSharedWith(page, [partner.workspaceName])
    } finally {
      await partnerContext.close()
    }
  })

  test("should show a host message and its file in the partner's copy when the partner lives in another region", async ({
    browser,
    page,
  }) => {
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage, "local-2")
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)

      const text = `Mockups for review ${host.testId}`
      await page.goto(`/w/${host.workspaceId}/s/${streamId}`)
      const editor = page.locator("[data-message-composer-root] [contenteditable='true']").first()
      await editor.click()
      await editor.pressSequentially(text)
      await pasteImage(page)
      await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10_000 })
      await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
      await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(0, { timeout: 15_000 })

      await openPartnerCopy(partnerPage, partner.workspaceId, streamId)
      await expect(partnerPage.getByRole("main").getByText(text)).toBeVisible({ timeout: 30_000 })
      const image = partnerPage.getByRole("main").locator("img[src*='/content?variant=thumbnail']")
      await expect(image).toBeAttached({ timeout: 30_000 })
      const src = await image.getAttribute("src")
      expect(src).toContain(`/api/workspaces/${partner.workspaceId}/attachments/`)

      const rawUrl = src!.replace("?variant=thumbnail", "")
      await expect
        .poll(
          async () => {
            const response = await partnerPage.request.get(rawUrl)
            return response.ok() && Buffer.compare(await response.body(), TEST_PNG) === 0
          },
          { timeout: 60_000 }
        )
        .toBe(true)
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth), { timeout: 30_000 })
        .toBe(1)
    } finally {
      await partnerContext.close()
    }
  })

  test("should carry a partner's reply, edit, reaction and delete to the host and the host's answer back when the partner lives in another region", async ({
    browser,
    page,
  }) => {
    // Six writes, each waiting on a cross-region pull.
    test.setTimeout(180_000)
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage, "local-2")
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)

      const opener = `Mockups for review ${host.testId}`
      const opened = await page.request.post(`/api/workspaces/${host.workspaceId}/messages`, {
        data: { streamId, content: opener },
      })
      await expectApiOk(opened, "Send host message")

      await openPartnerCopy(partnerPage, partner.workspaceId, streamId)
      await expect(timelineMessage(partnerPage, opener)).toBeVisible({ timeout: 30_000 })

      const reply = `Looks good to me ${host.testId}`
      await sendText(partnerPage, reply)
      await expect(timelineMessage(partnerPage, reply)).toBeVisible({ timeout: 15_000 })

      await page.goto(`/w/${host.workspaceId}/s/${streamId}`)
      await expect(timelineMessage(page, reply)).toBeVisible({ timeout: 30_000 })
      await expect(timelineMessage(page, reply)).toContainText(partner.name)

      const answer = `Thanks, shipping it ${host.testId}`
      await sendText(page, answer)
      await expect(timelineMessage(partnerPage, answer)).toBeVisible({ timeout: 30_000 })
      await expect(timelineMessage(partnerPage, answer)).toContainText(host.name)

      const edited = `Looks great to me ${host.testId}`
      await editMessage(partnerPage, timelineMessage(partnerPage, reply), edited)
      await expect(timelineMessage(partnerPage, edited)).toBeVisible({ timeout: 15_000 })
      await expect(timelineMessage(page, edited)).toBeVisible({ timeout: 30_000 })
      await expect(timelineMessage(page, reply)).toHaveCount(0)

      const emoji = await reactToMessage(partnerPage, timelineMessage(partnerPage, answer))
      await expect(timelineMessage(partnerPage, answer).getByRole("button").filter({ hasText: emoji })).toBeVisible({
        timeout: 15_000,
      })
      const hostPill = timelineMessage(page, answer).getByRole("button").filter({ hasText: emoji })
      await expect(hostPill).toBeVisible({ timeout: 30_000 })
      await expect(hostPill).toContainText("1")

      await deleteMessage(partnerPage, timelineMessage(partnerPage, edited))
      await expect(timelineMessage(partnerPage, edited)).toHaveCount(0, { timeout: 15_000 })
      await expect(timelineMessage(page, edited)).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await partnerContext.close()
    }
  })

  test("should notify a person in the other workspace when someone picks them from the mention picker in a shared channel or a new thread in it", async ({
    browser,
    page,
  }) => {
    test.setTimeout(180_000)
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage, "local-2")
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)

      const opened = await page.request.post(`/api/workspaces/${host.workspaceId}/messages`, {
        data: { streamId, content: `Mockups for review ${host.testId}` },
      })
      await expectApiOk(opened, "Send host message")

      await openPartnerCopy(partnerPage, partner.workspaceId, streamId)
      await expect(timelineMessage(partnerPage, host.testId)).toBeVisible({ timeout: 30_000 })
      const reply = `Looks good to me ${host.testId}`
      await sendText(partnerPage, reply)

      await page.goto(`/w/${host.workspaceId}/s/${streamId}`)
      await expect(timelineMessage(page, reply)).toBeVisible({ timeout: 30_000 })

      await clickReplyInThread(timelineMessage(page, reply))
      const hostAsk = ` can you check the colours ${host.testId}`
      const panelSend = page.getByTestId("panel").getByRole("button", { name: /^(Send|Reply)$/ })
      await sendMentionOf(getPanelEditor(page), panelSend, "partner", partner.name, hostAsk)
      await waitForRealThreadPanel(page)
      const partnerAsk = ` can you ship it ${host.testId}`
      await sendMentionOf(
        partnerPage.locator("[data-message-composer-root] [contenteditable='true']").first(),
        partnerPage.getByRole("main").getByRole("button", { name: "Send", exact: true }),
        "host",
        host.name,
        partnerAsk
      )

      await expectMentionActivity(partnerPage, partner.workspaceId, hostAsk.trim())
      await expectMentionActivity(page, host.workspaceId, partnerAsk.trim())
    } finally {
      await partnerContext.close()
    }
  })

  test("should carry a partner's file to the host and keep it in the partner's copy when the partner lives in another region", async ({
    browser,
    page,
  }) => {
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage, "local-2")
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)

      const text = `Partner mockups ${host.testId}`
      await openPartnerCopy(partnerPage, partner.workspaceId, streamId)
      const editor = partnerPage.locator("[data-message-composer-root] [contenteditable='true']").first()
      await editor.click()
      await editor.pressSequentially(text)
      await pasteImage(partnerPage)
      await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 10_000 })
      await partnerPage.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
      await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(0, { timeout: 15_000 })

      const partnerImage = timelineMessage(partnerPage, text).locator("img[src*='/content?variant=thumbnail']")
      await expect(partnerImage).toBeAttached({ timeout: 30_000 })
      expect(await partnerImage.getAttribute("src")).toContain(`/api/workspaces/${partner.workspaceId}/attachments/`)

      await page.goto(`/w/${host.workspaceId}/s/${streamId}`)
      await expect(timelineMessage(page, text)).toContainText(partner.name, { timeout: 30_000 })
      const hostImage = timelineMessage(page, text).locator("img[src*='/content?variant=thumbnail']")
      await expect(hostImage).toBeAttached({ timeout: 30_000 })
      const src = await hostImage.getAttribute("src")
      expect(src).toContain(`/api/workspaces/${host.workspaceId}/attachments/`)

      const rawUrl = src!.replace("?variant=thumbnail", "")
      await expect
        .poll(
          async () => {
            const response = await page.request.get(rawUrl)
            return response.ok() && Buffer.compare(await response.body(), TEST_PNG) === 0
          },
          { timeout: 60_000 }
        )
        .toBe(true)
      await expect
        .poll(() => hostImage.evaluate((node: HTMLImageElement) => node.naturalWidth), { timeout: 30_000 })
        .toBe(1)
    } finally {
      await partnerContext.close()
    }
  })

  test("should open a partner member's aside on a host message in their copy and let Ariadne answer there", async ({
    browser,
    page,
  }) => {
    test.setTimeout(150_000)
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      await partnerPage.setViewportSize({ width: 1600, height: 800 })
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage)
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)

      const opener = `Mockups for review ${host.testId}`
      const opened = await page.request.post(`/api/workspaces/${host.workspaceId}/messages`, {
        data: { streamId, content: opener },
      })
      await expectApiOk(opened, "Send host message")

      await openPartnerCopy(partnerPage, partner.workspaceId, streamId)
      const message = timelineMessage(partnerPage, opener)
      await expect(message).toBeVisible({ timeout: 30_000 })
      await message.hover()
      await message.getByRole("button", { name: "Message actions" }).click()
      await partnerPage.getByRole("menuitem", { name: "Open an aside here" }).click()

      const stage = partnerPage.getByTestId("aside-stage")
      await expect(stage).toBeVisible({ timeout: 15_000 })
      const asideId = await stage.getAttribute("data-aside-id")
      expect(asideId).toBeTruthy()
      await expect(
        partnerPage.locator(`[data-stream-scroller="${streamId}"]`).locator("[data-aside-id]").first()
      ).toHaveAttribute("data-aside-id", asideId!, { timeout: 15_000 })

      const asideChat = partnerPage.getByTestId("aside-conversation")
      await asideChat.locator("[contenteditable='true']").click()
      await partnerPage.keyboard.type("What is this about?")
      await partnerPage.keyboard.press("ControlOrMeta+Enter")
      await expect(
        asideChat.locator(".message-item").filter({ hasText: /stub response from the companion/ })
      ).toBeVisible({ timeout: 45_000 })
    } finally {
      await partnerContext.close()
    }
  })

  test("should leave the partner's copy readable but closed to replies, and drop the partner from the host's settings, when the partner admin disconnects", async ({
    browser,
    page,
  }) => {
    const partnerContext = await browser.newContext()
    try {
      const partnerPage = await partnerContext.newPage()
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage, "local-2")
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)

      const opener = `Mockups for review ${host.testId}`
      const opened = await page.request.post(`/api/workspaces/${host.workspaceId}/messages`, {
        data: { streamId, content: opener },
      })
      await expectApiOk(opened, "Send host message")
      await openPartnerCopy(partnerPage, partner.workspaceId, streamId)
      await expect(timelineMessage(partnerPage, opener)).toBeVisible({ timeout: 30_000 })
      await expect(partnerPage.getByText(`Shared with ${host.workspaceName}`)).toBeVisible({ timeout: 15_000 })

      await page.goto(`/w/${host.workspaceId}/s/${streamId}`)
      await expect(page.getByText(`Shared with ${partner.workspaceName}`)).toBeVisible({ timeout: 15_000 })

      await partnerPage.goto(settingsUrl(partner.workspaceId, streamId, "connect"))
      const settings = partnerPage.getByRole("dialog")
      await expect(settings.getByText("Only the workspace this channel comes from can share it.")).toBeVisible({
        timeout: 15_000,
      })
      await expect(settings.getByRole("button", { name: "Create invite link" })).toHaveCount(0)
      await settings.getByRole("button", { name: "Disconnect" }).click()
      const confirm = partnerPage.getByRole("alertdialog", { name: `Disconnect ${host.workspaceName}?` })
      await confirm.getByRole("button", { name: "Disconnect" }).click()
      // The alert hides the settings dialog from role queries while open, which would pass the checks below vacuously.
      await expect(confirm).toBeHidden()
      await expect(settings).toBeVisible()
      await expect(settings.getByRole("button", { name: "Disconnect" })).toHaveCount(0, { timeout: 15_000 })
      await expect(settings.getByText(host.workspaceName)).toHaveCount(0)
      await partnerPage.keyboard.press("Escape")

      await expect(
        partnerPage.getByText("This conversation is no longer shared with your workspace.", { exact: false })
      ).toBeVisible({ timeout: 30_000 })
      await expect(partnerPage.locator("[data-message-composer-root] [contenteditable='true']")).toHaveCount(0)
      await expect(partnerPage.getByText(`Shared with ${host.workspaceName}`)).toHaveCount(0)
      await expect(timelineMessage(partnerPage, opener)).toBeVisible()

      await expect(page.getByText(`Shared with ${partner.workspaceName}`)).toHaveCount(0, { timeout: 30_000 })
      const stillHere = `Still here ${host.testId}`
      await sendText(page, stillHere)
      // An optimistic row carries its client id until the server accepts the send.
      await expect(
        page.getByRole("main").locator('div[data-event-id][data-message-id^="msg_"]').filter({ hasText: stillHere })
      ).toBeVisible({ timeout: 15_000 })
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await expect(page.getByRole("dialog").getByRole("button", { name: "Create invite link" })).toBeVisible({
        timeout: 15_000,
      })
      await expect(page.getByRole("dialog").getByText(partner.workspaceName)).toHaveCount(0)
    } finally {
      await partnerContext.close()
    }
  })

  test("should bring a third workspace into a channel already shared with another, and list both after a reload", async ({
    browser,
    page,
  }) => {
    const contexts = [await browser.newContext(), await browser.newContext()]
    try {
      const [partnerPage, thirdPage] = await Promise.all(contexts.map((context) => context.newPage()))
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage)
      const third = await setUpWorkspace(thirdPage, "third")

      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      const secondInvite = await createInviteLink(page)
      await acceptInvite(thirdPage, secondInvite, slug, host.workspaceName, third.workspaceName, partner.workspaceName)

      const listing = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === `/api/workspaces/${host.workspaceId}/streams/${streamId}/connections`
      )
      await page.reload()
      const listed = await listing
      expect(listed.status()).toBe(200)
      const { connections } = (await listed.json()) as ListStreamConnectionsResponse
      expect(
        connections
          .filter((connection) => connection.state === "active")
          .map((connection) => connection.remoteWorkspaceName)
          .sort()
      ).toEqual([partner.workspaceName, third.workspaceName].sort())
      await expectSharedWith(page, [partner.workspaceName, third.workspaceName])
    } finally {
      await Promise.all(contexts.map((context) => context.close()))
    }
  })

  test("should bring a signed-out admin back to the invite after they sign in", async ({ browser, page }) => {
    const partnerContext = await browser.newContext()
    const signedOutContext = await browser.newContext()
    try {
      const { host, partner, slug, streamId } = await setUpHostAndPartner(page, await partnerContext.newPage())
      await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
      const invitePath = await createInviteLink(page)

      const visitor = await signedOutContext.newPage()
      await visitor.goto(invitePath)
      await expect(visitor.getByRole("heading", { name: "Sign in to connect a shared channel" })).toBeVisible()
      await visitor.getByRole("button", { name: "Sign in" }).click()
      await expect(visitor.getByRole("heading", { name: "Test Login" })).toBeVisible()
      await visitor.getByLabel("Email").fill(partner.email)
      await visitor.getByLabel("Name").fill(partner.name)
      await visitor.getByRole("button", { name: "Sign In" }).click()

      await expect(visitor).toHaveURL(new RegExp(`${invitePath}$`))
      await expect(visitor.getByRole("heading", { name: `#${slug} from ${host.workspaceName}` })).toBeVisible()
      await visitor.getByRole("button", { name: "Accept" }).click()
      await expect(
        visitor.getByRole("heading", { name: `#${slug} is shared with ${partner.workspaceName}` })
      ).toBeVisible()
    } finally {
      await Promise.all([partnerContext.close(), signedOutContext.close()])
    }
  })

  test.describe("on a phone", () => {
    test.use({ viewport: PHONE, hasTouch: true })

    test("should share a channel with another workspace and name it in the host's open settings", async ({
      browser,
      page,
    }) => {
      const partnerContext = await browser.newContext({ viewport: PHONE, hasTouch: true })
      try {
        const partnerPage = await partnerContext.newPage()
        const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage)

        await page.goto(settingsUrl(host.workspaceId, streamId, "general"))
        await page.getByRole("dialog").getByRole("combobox").first().click()
        await page.getByRole("option", { name: "Connect" }).click()
        const invitePath = await createInviteLink(page)

        await acceptInvite(partnerPage, invitePath, slug, host.workspaceName, partner.workspaceName)
        await expectSharedWith(page, [partner.workspaceName])
      } finally {
        await partnerContext.close()
      }
    })

    test("should name the other workspace in the stream sheet when the channel is shared", async ({
      browser,
      page,
    }) => {
      const partnerContext = await browser.newContext({ viewport: PHONE, hasTouch: true })
      try {
        const partnerPage = await partnerContext.newPage()
        const { host, partner, slug, streamId } = await setUpHostAndPartner(page, partnerPage)
        await page.goto(settingsUrl(host.workspaceId, streamId, "connect"))
        await acceptInvite(partnerPage, await createInviteLink(page), slug, host.workspaceName, partner.workspaceName)

        await page.goto(`/w/${host.workspaceId}/s/${streamId}`)
        await page.locator("header").getByRole("button", { name: "Stream actions" }).click()
        await expect(
          page.getByRole("dialog").getByText(`Shared with ${partner.workspaceName}`, { exact: true })
        ).toBeVisible({ timeout: 15_000 })
      } finally {
        await partnerContext.close()
      }
    })
  })
})
