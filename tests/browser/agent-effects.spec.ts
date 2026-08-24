import { test, expect, type Page } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace } from "./helpers"

/**
 * The effect surfaces, asserted in a real browser.
 *
 * These are the claims jsdom cannot judge, and every one of them shipped broken
 * at least once before a screenshot caught it: the grid had no icons, a long
 * diff clipped the label, and a viewport-keyed breakpoint gave a narrow board
 * card two columns that truncated every value in it. jsdom has no layout engine
 * and cannot evaluate a container query, so a unit test can only check that a
 * class name is present — never that the result is legible.
 *
 * The stub companion (`USE_STUB_COMPANION=true`) writes one tool step carrying
 * effects, so this exercises the real path — step column → collectSessionEffects
 * → lifecycle payload → grid — with no model call.
 */

const SESSION_TIMEOUT = 45_000
const MENTION_TEXT = "please do the thing"

/** The grid, once the session card has settled. */
function effectGrid(page: Page) {
  return page.locator(".effect-grid").first()
}

/**
 * A scratchpad runs the companion on every message, so this needs no mention
 * and no thread — the session card lands in the timeline the message was sent
 * to, which is the surface under test.
 */
async function runCompanionTurn(page: Page) {
  await createChannel(page, `effects-${Date.now()}`)

  // A mention is the path this suite already drives reliably. The agent runs in
  // a thread, so the session card — and the grid under it — renders in the
  // thread panel, which is one of the three surfaces that mounts it.
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
  await expect(effectGrid(page)).toBeVisible({ timeout: SESSION_TIMEOUT })
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

/** Rendered column count, read from the layout rather than from a class name. */
async function columnCount(page: Page): Promise<number> {
  return effectGrid(page).evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)
}

test.describe("agent effect surfaces", () => {
  // Each case drives a full mention → thread → session-complete round trip
  // before it can look at anything, which does not fit the default budget.
  test.describe.configure({ timeout: 120_000 })

  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "agent-effects")
  })

  /** Force the grid's container to a width and report the columns it chooses. */
  async function columnsAtWidth(page: Page, width: number): Promise<number> {
    await effectGrid(page).evaluate((el, w) => {
      const host = el.closest(".effect-grid-host") as HTMLElement | null
      if (!host) throw new Error("effect grid is missing its container-query host")
      host.style.width = `${w}px`
    }, width)
    return columnCount(page)
  }

  // Both directions of the threshold, driven by CONTAINER width at a fixed wide
  // viewport — which is the whole point. Note the thread panel this renders in
  // is itself narrow, so it sits on the one-column side by default; that is the
  // container query working, and it is why a viewport breakpoint got it wrong.
  test("pairs the rows only when the container is wide enough", async ({ page }) => {
    await runCompanionTurn(page)
    await page.setViewportSize({ width: 1280, height: 900 })

    expect(await columnsAtWidth(page, 800)).toBe(2)
    expect(await columnsAtWidth(page, 340)).toBe(1)
  })

  // The bug a viewport breakpoint cannot see: the same card in a narrow
  // container inside a wide window. `sm:` said "wide", the card was 360px, and
  // every value in it truncated.
  test("a narrow container drops to one column even on a wide viewport", async ({ page }) => {
    await runCompanionTurn(page)
    await page.setViewportSize({ width: 1280, height: 900 })

    await effectGrid(page).evaluate((el) => {
      const host = el.closest(".effect-grid-host") as HTMLElement | null
      if (!host) throw new Error("effect grid is missing its container-query host")
      host.style.width = "340px"
    })

    expect(await columnCount(page)).toBe(1)
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

    await effectGrid(page)
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

    await expect(effectGrid(page).getByRole("link", { name: /Plan out how to set up/ })).toBeVisible()
    await expect(effectGrid(page).getByRole("link", { name: /Check in on how things/ })).toHaveCount(0)
    await expect(effectGrid(page).getByText(/Check in on how things/)).toBeVisible()
  })

  // Truncation is the defect screenshots kept catching: a label clipped to
  // "Setti…" because a long diff took the row. Read the rendered text, not the
  // props.
  test("a short label is not clipped by the diff beside it", async ({ page }) => {
    await runCompanionTurn(page)
    await page.setViewportSize({ width: 390, height: 900 })

    const firstRow = effectGrid(page).locator("a, span").filter({ hasText: "Setting" }).first()
    await expect(firstRow).toContainText("Setting")

    const clipped = await firstRow.evaluate((el) => {
      const label = el.querySelector("span")
      return label ? label.scrollWidth > label.clientWidth + 1 : false
    })
    expect(clipped).toBe(false)
  })
})
