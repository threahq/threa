import { test, expect, type Locator, type Page } from "@playwright/test"
import type { ListStreamConnectionsResponse } from "@threahq/types"
import {
  enrollWorkspaceFlag,
  expectApiOk,
  loginAndCreateWorkspace,
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

      await partnerPage.goto(`/w/${partner.workspaceId}/s/${streamId}`)
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

  test("should carry a partner's reply, edit and reaction to the host and the host's answer back when the partner lives in another region", async ({
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

      await partnerPage.goto(`/w/${partner.workspaceId}/s/${streamId}`)
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
  })
})
