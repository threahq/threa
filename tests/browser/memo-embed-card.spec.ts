import { test, expect, type Page } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * The memo embed card's geometry, asserted in a real browser.
 *
 * This is the defect the suite exists for: the card used to be a line shorter
 * until its detail fetch landed, so a message carrying two of them pushed the
 * whole timeline down on first paint. jsdom has no layout engine and cannot
 * measure a box, so a unit test can only check that the reserved classes are
 * present — never that the result is the same height.
 *
 * The memo detail response is served from here rather than from a real memo:
 * the claim under test is the card's geometry across `pending` / `resolved` /
 * `missing`, and only a controlled response can hold a card in `pending` long
 * enough to measure it.
 */

const RESOLVED_MEMO_ID = "memo_01SLOTRESOLVED"
const MISSING_MEMO_ID = "memo_01SLOTMISSING"

/** A resolved detail payload, shaped like `serializeMemoDetail`. */
function memoDetail(memoId: string) {
  const now = new Date().toISOString()
  return {
    memo: {
      memo: {
        id: memoId,
        workspaceId: "ws_test",
        memoType: "conversation",
        sourceMessageId: null,
        sourceConversationId: null,
        // Long enough to take both title lines, so `resolved` is the TALLEST
        // this card can be — the state every other one has to match.
        title: "Switched the workspace theme to light and the timezone to Europe/Stockholm for the new region",
        abstract: "",
        keyPoints: [],
        sourceMessageIds: [],
        participantIds: [],
        knowledgeType: "decision",
        tags: ["settings", "preferences"],
        parentMemoId: null,
        status: "active",
        version: 1,
        revisionReason: null,
        authoredByKind: "agent",
        sourceSessionId: null,
        scope: "workspace",
        scopeUserId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      },
      distance: null,
      sourceStream: null,
      rootStream: null,
      successorMemoId: null,
      capturedByPersonaName: null,
      sourceMessages: [],
    },
  }
}

function memoCards(page: Page) {
  return page.locator('[data-type="memo-embed"]')
}

async function heightOf(page: Page, index: number): Promise<number> {
  const box = await memoCards(page).nth(index).boundingBox()
  if (!box) throw new Error(`memo card ${index} has no box`)
  return box.height
}

/** The title's own box — proves the date slot doesn't reflow the text beside it. */
async function titleBoxOf(page: Page, index: number) {
  return memoCards(page)
    .nth(index)
    .locator("p")
    .first()
    .evaluate((el) => {
      const box = el.getBoundingClientRect()
      return { width: Math.round(box.width), left: Math.round(box.left) }
    })
}

test.describe("memo embed card geometry", () => {
  test.describe.configure({ timeout: 120_000 })

  test("every state occupies the same box", async ({ page }) => {
    await loginAndCreateWorkspace(page, "memo-slots")
    await createChannel(page, `memo-slots-${Date.now()}`)

    const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
    if (!match) throw new Error(`no workspace/stream in URL: ${page.url()}`)
    const [, workspaceId, streamId] = match

    // The resolved memo is held until `release` fires, so the card can be
    // measured while it is genuinely still pending.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    await page.route(`**/api/workspaces/*/memos/${RESOLVED_MEMO_ID}`, async (route) => {
      await held
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(memoDetail(RESOLVED_MEMO_ID)),
      })
    })
    await page.route(`**/api/workspaces/*/memos/${MISSING_MEMO_ID}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "NOT_FOUND" } }),
      })
    )

    const post = (content: string) =>
      page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })

    expect((await post(`Card one [Theme switch](memo:${RESOLVED_MEMO_ID})`)).ok()).toBeTruthy()
    expect((await post(`Card two [Gone](memo:${MISSING_MEMO_ID})`)).ok()).toBeTruthy()

    await expect(memoCards(page)).toHaveCount(2, { timeout: 30_000 })

    // Pending: the first card's detail is still held.
    const pendingHeight = await heightOf(page, 0)
    const pendingTitle = await titleBoxOf(page, 0)

    // Missing: the second card's detail already 404'd.
    await expect(
      memoCards(page)
        .nth(1)
        .getByText(/no longer available/i)
    ).toBeVisible({ timeout: 15_000 })
    const missingHeight = await heightOf(page, 1)

    release()
    await expect(
      memoCards(page)
        .nth(0)
        .getByText(/decision/i)
    ).toBeVisible({ timeout: 15_000 })
    const resolvedHeight = await heightOf(page, 0)
    const resolvedTitle = await titleBoxOf(page, 0)

    // The whole point: resolving a memo must not change the card's height.
    expect(resolvedHeight).toBe(pendingHeight)
    expect(missingHeight).toBe(pendingHeight)

    // And the date arriving must not reflow the title beside it.
    expect(resolvedTitle).toEqual(pendingTitle)
  })

  test("a two-line title does not make the card taller than a one-line one", async ({ page }) => {
    await loginAndCreateWorkspace(page, "memo-slots-wrap")
    await createChannel(page, `memo-slots-wrap-${Date.now()}`)
    await page.setViewportSize({ width: 390, height: 900 })

    const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
    if (!match) throw new Error(`no workspace/stream in URL: ${page.url()}`)
    const [, workspaceId, streamId] = match

    await page.route(`**/api/workspaces/*/memos/${MISSING_MEMO_ID}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "NOT_FOUND" } }),
      })
    )

    const post = (content: string) =>
      page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })

    // Same memo id, so both cards land in the same `missing` state — the only
    // difference is the label length, which is what must not move the box.
    expect((await post(`Short [Auth](memo:${MISSING_MEMO_ID})`)).ok()).toBeTruthy()
    expect(
      (
        await post(
          `Long [A considerably longer memo label that has to wrap onto a second line on a narrow phone viewport](memo:${MISSING_MEMO_ID})`
        )
      ).ok()
    ).toBeTruthy()

    await expect(memoCards(page)).toHaveCount(2, { timeout: 30_000 })
    await expect(
      memoCards(page)
        .nth(1)
        .getByText(/no longer available/i)
    ).toBeVisible({ timeout: 15_000 })

    expect(await heightOf(page, 1)).toBe(await heightOf(page, 0))
  })
})
