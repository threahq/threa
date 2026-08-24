import { test, expect, type Page } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * The effect surfaces, asserted in a real browser.
 *
 * These are the claims jsdom cannot judge, and every one of them shipped broken
 * at least once before a screenshot caught it: change rows lost their icons,
 * long values clipped their labels, and a dense two-column layout made the
 * reading order hard to follow. A real browser proves the rows stay vertical
 * and legible at both desktop and phone widths.
 *
 * The stub companion (`USE_STUB_COMPANION=true`) writes one tool step carrying
 * effects, so this exercises the real path — step column → collectSessionEffects
 * → lifecycle payload → change list — with no model call.
 */

const SESSION_TIMEOUT = 45_000
const MENTION_TEXT = "please do the thing"

/** The change list, once the session card has settled. */
function effectList(page: Page) {
  return page.getByRole("list", { name: "Changes made" }).first()
}

/**
 * A scratchpad runs the companion on every message, so this needs no mention
 * and no thread — the session card lands in the timeline the message was sent
 * to, which is the surface under test.
 */
async function runCompanionTurn(page: Page) {
  await createChannel(page, `effects-${Date.now()}`)

  // A mention is the path this suite already drives reliably. The agent runs in
  // a thread, so the session card and its change list render in the thread
  // panel, which is one of the three surfaces that mounts it.
  const editor = page.locator("[contenteditable='true']")
  await editor.click()
  await page.keyboard.type("@ariadne")
  await expect(page.getByRole("option")).toBeVisible({ timeout: 5000 })
  await page.keyboard.press("Enter")
  await expect(editor.locator('span[data-type="mention"][data-slug="ariadne"]')).toBeVisible()
  await page.keyboard.type(` ${MENTION_TEXT}`)
  await page.keyboard.press("Meta+Enter")

  const { workspaceId, streamId, threadId } = await waitForThread(page, MENTION_TEXT)
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threadId}`)
  await expect(page.getByTestId("panel").getByText(/Session complete/)).toBeVisible({ timeout: SESSION_TIMEOUT })
  await expect(effectList(page)).toBeVisible({ timeout: SESSION_TIMEOUT })
}

/**
 * Poll the channel bootstrap until the agent has opened its thread. The thread
 * id hangs off the TRIGGER MESSAGE's payload, not off a session event — same
 * shape agent-activity.spec.ts uses.
 */
async function waitForThread(page: Page, messageText: string) {
  const match = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/)
  if (!match) throw new Error(`no workspace/stream in URL: ${page.url()}`)
  const [, workspaceId, streamId] = match
  const deadline = Date.now() + SESSION_TIMEOUT

  while (Date.now() < deadline) {
    const res = await page.request.get(`/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`)
    if (res.ok()) {
      const { data } = (await res.json()) as {
        data: {
          events: Array<{
            eventType: string
            payload?: { contentMarkdown?: string; threadId?: string; replyCount?: number }
          }>
        }
      }
      const trigger = data.events.find(
        (e) => e.eventType === "message_created" && e.payload?.contentMarkdown?.includes(messageText)
      )
      if (trigger?.payload?.threadId && (trigger.payload.replyCount ?? 0) > 0) {
        return { workspaceId, streamId, threadId: trigger.payload.threadId }
      }
    }
    await page.waitForTimeout(500)
  }
  throw new Error(`agent never opened a thread for: ${messageText}`)
}

test.describe("agent effect surfaces", () => {
  // Each case drives a full mention → thread → session-complete round trip
  // before it can look at anything, which does not fit the default budget.
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "agent-effects")
  })

  test("keeps every change in one vertical reading order at desktop and phone widths", async ({ page }) => {
    await runCompanionTurn(page)

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 900 },
    ]) {
      await page.setViewportSize(viewport)
      const rows = effectList(page).locator(":scope > li")
      await expect(rows).not.toHaveCount(0)
      const boxes = await rows.evaluateAll((items) =>
        items.map((item) => {
          const { top, bottom } = item.getBoundingClientRect()
          return { top, bottom }
        })
      )
      for (let index = 1; index < boxes.length; index++) {
        expect(boxes[index]!.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom)
      }
    }
  })

  // Every row is a link or inert text, and none of them may nest inside the
  // session card's own <a>. That is the structural claim the whole in-stream
  // design rests on, and invalid nesting renders fine while breaking keyboard
  // and screen-reader navigation.
  test("no effect row is nested inside another anchor or button", async ({ page }) => {
    await runCompanionTurn(page)

    // The memo row is a <button>, so the card link can trap that too.
    const nested = await page.evaluate(
      () => Array.from(document.querySelectorAll("a")).filter((a) => a.querySelector("a, button")).length
    )
    expect(nested).toBe(0)
  })

  // A memo has to open ON TOP of the stream, not navigate to the memory
  // explorer — the rule `memo-captured-event.tsx` already follows. Route and
  // stacking are both things only a real browser can settle.
  test("a memo effect opens over the stream instead of navigating away", async ({ page }) => {
    await runCompanionTurn(page)
    const before = page.url()

    await effectList(page)
      .getByRole("button", { name: /User test run/ })
      .click()

    const dialog = page.getByRole("dialog").first()
    await expect(dialog).toBeVisible()
    expect(page.url()).toBe(before)

    // On top of the timeline, not tucked behind it.
    const overTimeline = await dialog.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return el.contains(hit)
    })
    expect(overTimeline).toBe(true)
  })

  // A follow-up has no route anywhere in the app, so its row must be inert
  // rather than a link that goes nowhere.
  test("a routeless effect renders inert while a routed one links", async ({ page }) => {
    await runCompanionTurn(page)

    await expect(effectList(page).getByRole("link", { name: /Plan out how to set up/ })).toBeVisible()
    await expect(effectList(page).getByRole("link", { name: /Check in on how things/ })).toHaveCount(0)
    await expect(effectList(page).getByText(/Check in on how things/)).toBeVisible()
  })

  // Truncation is the defect screenshots kept catching: a label clipped to
  // "Setti…" because a long diff took the row. Read the rendered text, not the
  // props.
  test("a short label is not clipped by the diff beside it", async ({ page }) => {
    await runCompanionTurn(page)
    await page.setViewportSize({ width: 390, height: 900 })

    const firstRow = effectList(page).locator("li").filter({ hasText: "Setting" }).first()
    await expect(firstRow).toContainText("Setting")

    const clipped = await firstRow.evaluate((el) => {
      const label = el.querySelector("span")
      return label ? label.scrollWidth > label.clientWidth + 1 : false
    })
    expect(clipped).toBe(false)
    await expect(firstRow.getByText("Before")).toBeVisible()
    await expect(firstRow.getByText("After")).toBeVisible()
    await expect(firstRow.locator("del")).toBeVisible()
    await expect(firstRow.locator("ins")).toBeVisible()
  })
})
