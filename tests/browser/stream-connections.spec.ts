import { test, expect, type Page } from "@playwright/test"
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
