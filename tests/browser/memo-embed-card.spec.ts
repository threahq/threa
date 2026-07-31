import { test, expect, type Page } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * The memo embed card, asserted in a real browser.
 *
 * The rule: content may change only when the memo changed, never because it had
 * not loaded yet. The two claims here are that the card is complete on its first
 * paint and that nothing about it moves afterwards — neither of which jsdom can
 * judge, having no layout engine.
 *
 * These used to be "every state is the same height" assertions, from when the
 * card fetched per render and had to reserve space for a pending state. There is
 * no pending state now: the summary rides the message, so the card is sized by
 * its own content and simply never changes.
 *
 * Whether the SERVER puts the right summary on the payload is settled by
 * `memo-embed-payloads.test.ts` and `memo-embed-summaries.test.ts` against real
 * rows. What is only observable here is what the browser does with it, so the
 * payload is supplied from the test rather than seeded through GAM extraction.
 */

const LOAD_TIMEOUT = 30_000
const MEMO_ID = "memo_01CARDSUMMARY"

const SUMMARY = {
  memoId: MEMO_ID,
  title: "Switched the workspace theme to light and the timezone to Europe/Stockholm",
  knowledgeType: "decision",
  memoType: "conversation",
  tags: ["settings", "preferences"],
  updatedAt: "2026-07-30T10:00:00.000Z",
}

function memoCards(page: Page) {
  return page.locator('[data-type="memo-embed"]')
}

/** Records layout shifts, tagging any whose source sits inside a memo card. */
async function installShiftProbe(page: Page) {
  await page.addInitScript(() => {
    const shifts: Array<{ value: number; inMemoCard: boolean }> = []
    ;(window as unknown as { __shifts: typeof shifts }).__shifts = shifts
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number
          hadRecentInput: boolean
          sources?: Array<{ node?: Node }>
        }
        if (shift.hadRecentInput) continue
        const inMemoCard = (shift.sources ?? []).some((source) => {
          const el = source.node as HTMLElement | null
          return !!el?.closest?.('[data-type="memo-embed"]')
        })
        shifts.push({ value: shift.value, inMemoCard })
      }
    }).observe({ type: "layout-shift", buffered: true })
  })
}

/** Serve the stream bootstrap with `memoEmbeds` stamped onto our message. */
async function stampSummaryOntoBootstrap(page: Page) {
  await page.route("**/api/workspaces/*/streams/*/bootstrap*", async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as {
      data?: { events?: Array<{ eventType: string; payload?: Record<string, unknown> }> }
    }
    for (const event of body.data?.events ?? []) {
      if (event.eventType !== "message_created") continue
      const markdown = event.payload?.contentMarkdown
      if (typeof markdown === "string" && markdown.includes(MEMO_ID)) {
        event.payload = { ...event.payload, memoEmbeds: [SUMMARY] }
      }
    }
    await route.fulfill({ response, body: JSON.stringify(body), contentType: "application/json" })
  })
}

test.describe("memo embed card", () => {
  test.describe.configure({ timeout: 120_000 })

  test("renders the memo's content on first paint and never moves after it", async ({ page }) => {
    await loginAndCreateWorkspace(page, "memo-card")
    await createChannel(page, `memo-card-${Date.now()}`)

    const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
    if (!match) throw new Error(`no workspace/stream in URL: ${page.url()}`)
    const [, workspaceId, streamId] = match

    const sendRes = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: `Decided: [Theme switch](memo:${MEMO_ID})` },
    })
    expect(sendRes.ok()).toBeTruthy()

    await stampSummaryOntoBootstrap(page)
    await installShiftProbe(page)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)

    const card = memoCards(page).first()
    await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT })

    // Complete on arrival: the memo's own title, its knowledge type and its
    // tags — none of which the markdown reference carries. "Theme switch" is
    // the reference's label; the memo's title is longer and different.
    await expect(card).toContainText(/decision/i)
    await expect(card).toContainText("settings")
    await expect(card).toContainText("Switched the workspace theme to light")

    const height = await card.evaluate((el) => el.getBoundingClientRect().height)
    await page.waitForTimeout(2000)
    expect(await card.evaluate((el) => el.getBoundingClientRect().height)).toBe(height)

    const memoShifts = await page.evaluate(() =>
      (window as unknown as { __shifts: Array<{ value: number; inMemoCard: boolean }> }).__shifts.filter(
        (shift) => shift.inMemoCard
      )
    )
    expect(memoShifts).toEqual([])
  })

  test("a memo with no summary renders its label alone, and never goes looking for one", async ({ page }) => {
    await loginAndCreateWorkspace(page, "memo-card-bare")
    await createChannel(page, `memo-card-bare-${Date.now()}`)

    const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
    if (!match) throw new Error(`no workspace/stream in URL: ${page.url()}`)
    const [, workspaceId, streamId] = match

    // A reference to a memo that does not exist stands in for every case where
    // no summary can ride the message — a sealed body, pre-ship history, a memo
    // the room can't uniformly read. The card must still render, and must not go
    // and ask for it.
    const sendRes = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: `Cited: [Some memo](memo:memo_01NOTAREALMEMOID)` },
    })
    expect(sendRes.ok()).toBeTruthy()

    let memoDetailRequests = 0
    page.on("request", (request) => {
      if (/\/api\/workspaces\/[^/]+\/memos\/memo_/.test(request.url())) memoDetailRequests++
    })

    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    const card = memoCards(page).first()
    await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT })
    await expect(card).toContainText("Some memo")

    await page.waitForTimeout(2000)
    expect(memoDetailRequests).toBe(0)
  })
})
