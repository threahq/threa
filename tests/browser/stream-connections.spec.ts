import { test, expect, type Browser, type Page } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * Sharing a channel across workspaces: the host admin mints an invite link from
 * channel settings, a partner admin opens it in another workspace's session and
 * accepts, and the host's settings then name the partner.
 */

test.describe.configure({ timeout: 90_000 })

const PHONE = { width: 390, height: 844 }

async function enrollStreamConnections(page: Page, workspaceId: string): Promise<void> {
  const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT
  const internalApiKey = process.env.PLAYWRIGHT_INTERNAL_API_KEY
  if (!backendPort || !internalApiKey) throw new Error("Browser test feature-flag fixture is unavailable")
  await expectApiOk(
    await page.request.post(`http://localhost:${backendPort}/internal/feature-flags`, {
      headers: { "x-internal-api-key": internalApiKey },
      data: { workspaceId, subjectType: "workspace", subjectId: workspaceId, overrides: { streamConnections: "on" } },
    }),
    "Enroll workspace in streamConnections"
  )
}

function workspaceIdFromUrl(page: Page): string {
  const match = page.url().match(/\/w\/([^/?]+)/)
  if (!match) throw new Error(`No workspace id in ${page.url()}`)
  return match[1]
}

async function setUpWorkspace(page: Page, prefix: string) {
  const created = await loginAndCreateWorkspace(page, prefix)
  const workspaceId = workspaceIdFromUrl(page)
  await enrollStreamConnections(page, workspaceId)
  return { ...created, workspaceId }
}

async function setUpHostAndPartner(browser: Browser, hostPage: Page, contextOptions = {}) {
  const host = await setUpWorkspace(hostPage, "host")
  const slug = `design-${host.testId}`
  const response = await hostPage.request.post(`/api/workspaces/${host.workspaceId}/streams`, {
    data: { type: "channel", slug, visibility: "public" },
  })
  await expectApiOk(response, "Create channel")
  const streamId = ((await response.json()) as { stream: { id: string } }).stream.id

  const partnerContext = await browser.newContext(contextOptions)
  const partnerPage = await partnerContext.newPage()
  const partner = await setUpWorkspace(partnerPage, "partner")

  return { host, partner, partnerPage, partnerContext, slug, streamId }
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

async function acceptInvite(page: Page, invitePath: string, slug: string, hostName: string, partnerName: string) {
  await page.goto(invitePath)
  await expect(page.getByRole("heading", { name: `#${slug} from ${hostName}` })).toBeVisible()
  await expect(page.getByText("Hosted in Local.", { exact: false })).toBeVisible()
  await expect(page.getByRole("combobox")).toHaveText(partnerName)
  await page.getByRole("button", { name: "Accept" }).click()
  await expect(page.getByRole("heading", { name: `#${slug} is shared with ${partnerName}` })).toBeVisible()
  await expect(page.getByRole("link", { name: `Open ${partnerName}` })).toBeVisible()
}

async function expectSharedWith(page: Page, workspaceId: string, streamId: string, partnerName: string) {
  await page.goto(settingsUrl(workspaceId, streamId, "connect"))
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Shared with")).toBeVisible()
  await expect(dialog.getByText(partnerName)).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Create invite link" })).toHaveCount(0)
}

test.describe("Stream connections", () => {
  test("should share a channel with another workspace when its admin accepts the invite", async ({ browser, page }) => {
    const { host, partner, partnerPage, partnerContext, slug, streamId } = await setUpHostAndPartner(browser, page)

    try {
      await page.goto(settingsUrl(host.workspaceId, streamId, "general"))
      await page
        .locator('[data-slot="settings-nav"]')
        .getByRole("button", { name: /Connect/ })
        .click()
      const invitePath = await createInviteLink(page)

      await acceptInvite(partnerPage, invitePath, slug, host.workspaceName, partner.workspaceName)
      await expectSharedWith(page, host.workspaceId, streamId, partner.workspaceName)
    } finally {
      await partnerContext.close()
    }
  })

  test.describe("on a phone", () => {
    test.use({ viewport: PHONE, hasTouch: true })

    test("should share a channel with another workspace when its admin accepts the invite", async ({
      browser,
      page,
    }) => {
      const { host, partner, partnerPage, partnerContext, slug, streamId } = await setUpHostAndPartner(browser, page, {
        viewport: PHONE,
        hasTouch: true,
      })

      try {
        await page.goto(settingsUrl(host.workspaceId, streamId, "general"))
        await page.getByRole("dialog").getByRole("combobox").first().click()
        await page.getByRole("option", { name: "Connect" }).click()
        const invitePath = await createInviteLink(page)

        await acceptInvite(partnerPage, invitePath, slug, host.workspaceName, partner.workspaceName)
        await expectSharedWith(page, host.workspaceId, streamId, partner.workspaceName)
      } finally {
        await partnerContext.close()
      }
    })
  })
})
