import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * The outcomes page, asserted in a real browser.
 *
 * NOT end-to-end coverage: a real follow-up or delegation needs an agent turn,
 * which this suite has no cheap way to drive, so the `agent-outcomes` response
 * is stubbed with fixed fixtures. Everything else is real — real Chromium, real
 * CSS, real component tree, real routing. These are layout claims, which jsdom
 * cannot judge at all: it has no layout engine, so a unit test can only see that
 * a class name is present, never that the result is legible.
 */

const STREAM_NAME_TITLE = "Check in on the migration once the read replica has caught up and the backfill has drained"

function outcome(overrides: Record<string, unknown>) {
  return {
    kind: "follow_up",
    id: "fup_1",
    streamId: "str_seed",
    title: "Check in on the migration",
    status: "pending",
    scheduledFor: "2030-01-01T18:00:00.000Z",
    claimedByLabel: null,
    statusNote: null,
    resultMessageId: null,
    actorType: "persona",
    actorId: "persona_1",
    createdAt: "2026-07-28T09:00:00.000Z",
    statusChangedAt: "2026-07-28T09:00:00.000Z",
    occursAt: "2030-01-01T18:00:00.000Z",
    anchorEventId: null,
    ...overrides,
  }
}

/** Enough rows, across enough days, that the list must scroll and group. */
function fixtures() {
  const items: Array<Record<string, unknown>> = [
    outcome({ id: "fup_overdue", title: "Overdue check-in", occursAt: "2020-01-01T09:00:00.000Z" }),
    outcome({
      id: "deleg_running",
      kind: "delegation",
      title: "Run the schema migration locally",
      status: "running",
      scheduledFor: null,
      claimedByLabel: "kris@laptop",
      occursAt: "2020-01-02T09:00:00.000Z",
    }),
    outcome({ id: "fup_long", title: STREAM_NAME_TITLE, occursAt: "2030-01-01T18:00:00.000Z" }),
  ]
  for (let i = 0; i < 30; i++) {
    items.push(
      outcome({
        id: `fup_bulk_${i}`,
        title: `Scheduled follow-up number ${i}`,
        occursAt: new Date(Date.UTC(2030, 0, 2 + i, 9)).toISOString(),
      })
    )
  }
  return items
}

async function stubOutcomes(page: Page) {
  // Scoped to the API path on purpose: a bare `**/agent-outcomes*` also matches
  // the dev server's module requests for `api/agent-outcomes.ts` and
  // `hooks/use-agent-outcomes.ts`, which then arrive as JSON and blank the app.
  await page.route("**/api/workspaces/*/agent-outcomes*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: fixtures(), nextCursor: null, outstandingCount: fixtures().length }),
    })
  })
}

async function openOutcomes(page: Page) {
  const match = page.url().match(/\/w\/([^/?]+)/)
  if (!match) throw new Error(`no workspace in URL: ${page.url()}`)
  await stubOutcomes(page)
  await page.goto(`/w/${match[1]}/agenda?aState=all`)
  await expect(page.getByTestId("outcomes-list")).toBeVisible({ timeout: 15_000 })
}

/** The element that actually scrolls the rows — the list's own overflow box. */
function listScroller(page: Page) {
  return page.getByTestId("outcomes-list").locator("xpath=..")
}

test.describe("agent outcomes page", () => {
  test.beforeEach(async ({ page }) => {
    await loginAndCreateWorkspace(page, "outcomes")
  })

  test("the detail pane sits beside the list at 1440px and not at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openOutcomes(page)

    await page.getByRole("button", { name: /Overdue check-in/ }).click()

    const listBox = await listScroller(page).boundingBox()
    const detailBox = await page.getByTestId("outcomes-detail-pane").boundingBox()
    if (!listBox || !detailBox) throw new Error("list or detail pane is not laid out")
    expect(detailBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width - 1)

    await page.setViewportSize({ width: 390, height: 844 })
    const sideBySide = await page.evaluate(() => {
      const list = document.querySelector("[data-testid='outcomes-list']")
      const detail = document.querySelector("[data-testid='outcomes-detail-pane']")
      if (!list || !detail) return false
      const l = list.getBoundingClientRect()
      const d = detail.getBoundingClientRect()
      return d.width > 0 && l.width > 0 && d.x >= l.x + l.width - 1
    })
    expect(sideBySide).toBe(false)

    const bodyOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    )
    expect(bodyOverflows).toBe(false)
  })

  // A `fullPage` screenshot cannot see this: the page itself never scrolls, so
  // the defect (rows scrolling the whole document and taking the header with
  // them) looks identical in an image.
  test("the list scrolls inside its own container while the header stays put", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 })
    await openOutcomes(page)

    const scroller = listScroller(page)
    const scrollable = await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
    expect(scrollable).toBe(true)

    const header = page.getByRole("heading", { name: "Agent agenda" })
    const before = await header.boundingBox()
    await scroller.evaluate((el) => {
      el.scrollTop = 400
    })
    const scrolled = await scroller.evaluate((el) => el.scrollTop)
    expect(scrolled).toBeGreaterThan(0)

    const after = await header.boundingBox()
    expect(after?.y).toBeCloseTo(before?.y ?? -1, 0)

    const documentScrolled = await page.evaluate(() => document.documentElement.scrollTop)
    expect(documentScrolled).toBe(0)
  })

  test("a long follow-up note truncates with the status pill still fully visible", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openOutcomes(page)

    const row = page.locator("[data-outcome-id='fup_long']")
    await row.scrollIntoViewIfNeeded()

    const title = row.locator("span").first()
    const truncated = await title.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(truncated).toBe(true)

    const pill = row.getByText("Scheduled", { exact: true })
    const pillBox = await pill.boundingBox()
    const rowBox = await row.boundingBox()
    if (!pillBox || !rowBox) throw new Error("row or pill is not laid out")
    expect(pillBox.width).toBeGreaterThan(0)
    expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
    const pillClipped = await pill.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(pillClipped).toBe(false)
  })

  test("the chip row wraps rather than overflowing at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openOutcomes(page)

    const chips = page.getByTestId("outcomes-chips")
    const overflows = await chips.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    expect(overflows).toBe(false)

    // Wrapped, not shrunk onto one clipped line: the chips occupy more than one
    // row box.
    const rows = await chips.evaluate((el) => {
      const tops = Array.from(el.children).map((child) => Math.round(child.getBoundingClientRect().top))
      return new Set(tops).size
    })
    expect(rows).toBeGreaterThan(1)
  })

  test("at 390px selecting a row replaces the list with the detail, and back returns", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openOutcomes(page)

    const list = page.getByTestId("outcomes-list")
    const detail = page.getByTestId("outcomes-detail-pane")

    await page.getByRole("button", { name: /Overdue check-in/ }).click()

    await expect(list).toBeHidden()
    await expect(detail).toBeVisible()
    const detailBox = await detail.boundingBox()
    expect(detailBox?.width ?? 0).toBeGreaterThan(300)

    await page.getByRole("button", { name: "Back to the agenda list" }).click()

    await expect(list).toBeVisible()
    const detailWidth = await detail.evaluate((el) => el.getBoundingClientRect().width)
    expect(detailWidth).toBe(0)
  })

  test("at 800px the layout is stacked, not a crushed split", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 })
    await openOutcomes(page)

    const listWidth = await listScroller(page).evaluate((el) => el.getBoundingClientRect().width)
    const detailWidthBefore = await page
      .getByTestId("outcomes-detail-pane")
      .evaluate((el) => el.getBoundingClientRect().width)
    expect(detailWidthBefore).toBe(0)
    expect(listWidth).toBeGreaterThan(400)

    await page.getByRole("button", { name: /Overdue check-in/ }).click()

    await expect(page.getByTestId("outcomes-list")).toBeHidden()
    const detailWidthAfter = await page
      .getByTestId("outcomes-detail-pane")
      .evaluate((el) => el.getBoundingClientRect().width)
    expect(detailWidthAfter).toBeGreaterThan(400)
  })

  test("day headers stay legible while the list is scrolled", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 })
    await openOutcomes(page)

    const scroller = listScroller(page)
    await scroller.evaluate((el) => {
      el.scrollTop = 600
    })

    const visibleHeader = await page.evaluate(() => {
      const sections = Array.from(document.querySelectorAll("[data-testid='outcomes-list'] section > div:first-child"))
      const scrollerEl = document.querySelector("[data-testid='outcomes-list']")?.parentElement
      if (!scrollerEl) return null
      const bounds = scrollerEl.getBoundingClientRect()
      for (const section of sections) {
        const rect = section.getBoundingClientRect()
        if (rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 && rect.height > 0) {
          return { text: (section.textContent ?? "").trim(), height: rect.height }
        }
      }
      return null
    })
    expect(visibleHeader).not.toBeNull()
    expect(visibleHeader!.text.length).toBeGreaterThan(0)
    expect(visibleHeader!.height).toBeGreaterThan(8)
  })
})
