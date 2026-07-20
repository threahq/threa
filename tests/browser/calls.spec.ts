import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, expectApiOk, createDmDraftId, generateTestId } from "./helpers"

/**
 * Two-context 1:1 DM call e2e (plan §Rollout M1 exit gate, PR 1.5). Real browser
 * A + real browser B against the dev-test stack with the fake Cloudflare seam
 * (negotiationless — see tests/browser/fake-cf-runner.ts): the media plane
 * forwards nothing, so every assertion is on the CONTROL plane (roster / dock /
 * ring / timeline card via the `/calls` socket + outbox), never getStats bytes.
 *
 * Fake media (`--use-fake-device-for-media-stream` + auto-accepted permission,
 * wired in playwright.config.ts's `calls` project) lets getUserMedia resolve and
 * the call reach the connected phase headless without a real device.
 *
 * Grace + sweep run low in this stack (CALL_EMPTY_GRACE_MS / CALL_SWEEP_INTERVAL_MS)
 * so an emptied call reaches `ended` — and its timeline card flips — inside the
 * test window.
 */

const CALL_TILE = "[data-testid='call-tile']"

interface DmPair {
  ownerContext: BrowserContext
  ownerPage: Page
  inviteeContext: BrowserContext
  inviteePage: Page
  workspaceId: string
  dmStreamId: string
  inviteeUserId: string
}

/** A owner + B member sharing a real DM stream, both viewing it, calls enabled. */
async function setUpDmPair(browser: Browser): Promise<DmPair> {
  const testId = generateTestId()
  const inviteeEmail = `calls-b-${testId}@example.com`
  const inviteeName = `Calls B ${testId}`

  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  const invitee = await loginInNewContext(browser, inviteeEmail, inviteeName)

  await loginAndCreateWorkspace(ownerPage, "calls-a")
  const workspaceId = ownerPage.url().match(/\/w\/([^/]+)/)?.[1]
  if (!workspaceId) throw new Error("Could not resolve workspaceId from owner URL")

  // Flip the workspace `callsEnabled` dark-feature flag on (admin-only; owner is admin).
  await expectApiOk(
    await ownerPage.request.patch(`/api/workspaces/${workspaceId}/workspace-settings`, {
      data: { callsEnabled: true },
    }),
    "Enable calls"
  )

  // B joins the workspace as a member.
  await expectApiOk(
    await invitee.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: inviteeName },
    }),
    "Invitee joins workspace"
  )

  // Resolve B's user id, then materialize the DM by sending the first message from A.
  const usersBody = (await ownerPage.request.get(`/api/workspaces/${workspaceId}/users`).then((r) => r.json())) as {
    users: Array<{ id: string; name: string }>
  }
  const inviteeUserId = usersBody.users.find((u) => u.name === inviteeName)?.id
  if (!inviteeUserId) throw new Error("Invitee user not found in workspace")

  await ownerPage.goto(`/w/${workspaceId}/s/${createDmDraftId(inviteeUserId)}`)
  await ownerPage.locator("[contenteditable='true']").first().click()
  await ownerPage.keyboard.type(`DM open ${testId}`)
  await ownerPage.getByRole("button", { name: "Send" }).click()
  await expect(ownerPage).toHaveURL(new RegExp(`/w/${workspaceId}/s/stream_`), { timeout: 15000 })
  const dmStreamId = ownerPage.url().match(/\/s\/([^/?]+)/)?.[1]
  if (!dmStreamId) throw new Error("DM stream id not resolved after first message")

  // Reload A so its bootstrap picks up `callsEnabled` (the header call button is
  // dark until then), and land B on the same DM so both see the timeline card.
  await ownerPage.reload()
  await invitee.page.goto(`/w/${workspaceId}/s/${dmStreamId}`)

  // The call button proves A's bootstrap has calls on; the composer proves B is in.
  await expect(ownerPage.getByRole("button", { name: "Start a call" })).toBeVisible({ timeout: 15000 })
  await expect(invitee.page.locator("[contenteditable='true']").first()).toBeVisible({ timeout: 15000 })

  return {
    ownerContext,
    ownerPage,
    inviteeContext: invitee.context,
    inviteePage: invitee.page,
    workspaceId,
    dmStreamId,
    inviteeUserId,
  }
}

async function startCallFromHeader(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start a call" }).click()
  // The dock renders once the connected phase lands — self tile present.
  await expect(page.locator(CALL_TILE)).toHaveCount(1, { timeout: 20000 })
}

test.describe("1:1 DM calls", () => {
  test("happy path: ring → accept → both docks converge → leave → ended card", async ({ browser }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b } = pair
    try {
      // A starts the call; B's overlay rings.
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })

      // B accepts → both docks show 2 participants (control-plane roster).
      await b.getByRole("button", { name: "Accept call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })

      // A leaves → A's dock tears down; B is now alone in the call.
      await a.getByRole("button", { name: "Leave call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(1, { timeout: 20000 })

      // B leaves → the call empties → grace → ended; the timeline card flips for both.
      await b.getByRole("button", { name: "Leave call" }).click()
      await expect(b.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })

      await expect(a.getByText(/Call ended/i)).toBeVisible({ timeout: 30000 })
      await expect(b.getByText(/Call ended/i)).toBeVisible({ timeout: 30000 })
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("decline: B declines → ring settles, A stays in the call", async ({ browser }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b } = pair
    try {
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })

      await b.getByRole("button", { name: "Decline call" }).click()
      // B's ring overlay clears; A remains connected (still a live dock).
      await expect(b.getByText(/is calling/i)).toHaveCount(0, { timeout: 20000 })
      await expect(a.locator(CALL_TILE)).toHaveCount(1, { timeout: 10000 })

      await a.getByRole("button", { name: "Leave call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("abandonment: A hangs up before answer → B's ring clears, no missed call", async ({ browser }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b, workspaceId } = pair
    try {
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })

      // A hangs up while still the only participant — the 1.3 regression: this must
      // CANCEL the ring, not let it expire into a missed-call activity for B.
      await a.getByRole("button", { name: "Leave call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })

      // B's overlay clears via the settle broadcast.
      await expect(b.getByText(/is calling/i)).toHaveCount(0, { timeout: 20000 })

      // Give grace + sweep time to fire, then assert B has NO missed-call
      // activity. The 45s ring-expiry path is NOT waited out here — it doesn't
      // need to be: the overlay-clears-within-20s assertion above can only pass
      // via a real server settle (the client auto-dismiss backstop fires at 45s),
      // and a settled ring is out of 'ringing', so a later expiry sweep can't
      // turn it into a missed call.
      await b.waitForTimeout(6000)
      const activities = (await b.request.get(`/api/workspaces/${workspaceId}/activity`).then((r) => r.json())) as {
        activities: Array<{ activityType: string }>
      }
      const missed = activities.activities.filter((row) => row.activityType === "missed_call")
      expect(missed).toHaveLength(0)
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("rejoin: A reloads mid-call → rejoin bar → both docks reconverge", async ({ browser }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b, workspaceId, dmStreamId } = pair
    try {
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })
      await b.getByRole("button", { name: "Accept call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })

      // A reloads: the media incarnation is gone, but A's `joined` participant row
      // survives under its lease (B keeps the call active), so the rejoin bar shows.
      await a.reload()
      await a.goto(`/w/${workspaceId}/s/${dmStreamId}`)
      await expect(a.getByText(/still in this call/i)).toBeVisible({ timeout: 25000 })

      await a.getByRole("button", { name: "Rejoin" }).click()
      // Both docks converge back to 2 participants.
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 25000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 25000 })

      await a.getByRole("button", { name: "Leave call" }).click()
      await b.getByRole("button", { name: "Leave call" }).click()
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })
})
