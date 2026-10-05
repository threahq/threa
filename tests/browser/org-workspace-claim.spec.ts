import { expect, test, type Browser, type Page } from "@playwright/test"
import { devLogin, expectApiOk, generateTestId } from "./helpers"

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true }

/** No product path creates an org workspace yet, so the stub-auth-only control-plane route seeds one. */
async function seedOrgWorkspace(page: Page, domain: string, name: string, people: unknown[]): Promise<string> {
  const port = process.env.PLAYWRIGHT_CONTROL_PLANE_PORT
  if (!port) throw new Error("PLAYWRIGHT_CONTROL_PLANE_PORT is unset")
  const response = await page.request.post(`http://localhost:${port}/api/dev/org-workspaces`, {
    data: { domain, name, people },
  })
  await expectApiOk(response, "Seed org workspace")
  return ((await response.json()) as { workspaceId: string }).workspaceId
}

async function signInAndExpectRole(
  browser: Browser,
  mobile: boolean,
  person: { email: string; name: string; listedAs: string },
  workspace: { id: string; name: string },
  role: string
) {
  const context = await browser.newContext(mobile ? PHONE : undefined)
  const page = await context.newPage()
  try {
    await devLogin(page, person.email, person.name)
    await page.goto("/workspaces")
    await page.getByRole("link", { name: workspace.name }).click()
    await page.waitForURL((url) => url.pathname.startsWith(`/w/${workspace.id}`))

    // The region applies the claim from the control-plane outbox, so the role can land after first paint.
    await expect(async () => {
      await page.goto(`/w/${workspace.id}?ws-settings=users`)
      const row = page.getByRole("listitem").filter({ hasText: person.listedAs })
      await expect(row.getByText(role, { exact: true })).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 30_000 })
  } finally {
    await context.close()
  }
}

async function claimJourney(page: Page, browser: Browser, mobile: boolean) {
  const testId = generateTestId()
  const domain = `claim-${testId}.test`
  const workspaceName = `Claim ${testId}`
  const alice = { email: `alice@${domain}`, name: `Alice ${testId}`, listedAs: `Alice Seeded ${testId}` }
  const bob = { email: `bob@${domain}`, name: `Bob ${testId}`, listedAs: `Bob ${testId}` }
  const workspaceId = await seedOrgWorkspace(page, domain, workspaceName, [
    { name: alice.listedAs, email: alice.email.toUpperCase(), externalIdentity: null },
  ])
  const workspace = { id: workspaceId, name: workspaceName }

  await signInAndExpectRole(browser, mobile, alice, workspace, "Owner")
  await signInAndExpectRole(browser, mobile, bob, workspace, "Member")
}

test.describe("Org workspace claim", () => {
  test("should make the first person on the domain owner and the next a member on desktop", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000)
    await claimJourney(page, browser, false)
  })

  test("should make the first person on the domain owner and the next a member on a phone", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000)
    await claimJourney(page, browser, true)
  })
})
