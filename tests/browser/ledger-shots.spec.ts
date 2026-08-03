import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

// Throwaway visual pass for the ledger board stack — deleted after the run.

const LONG_BODIES = [
  "Verify pass came back: 4 accepted, 0 refuted. The two that mattered were the re-arming anchor adopting a page of uncompensated growth, and the phantom-page stacking under an unsynced rail.\n\nFix batch is running now; the falsification checks neutralise each guard in turn and re-run the suite, so a fix that does nothing shows up as a green test that should have been red.\n\nGates: 5584 frontend tests, typecheck clean, lint clean across the monorepo.",
  "Third explorer back — the data model. This is the one that changes what I think the work is.\n\nThe conversation projection and the event rail can disagree under latency: the projection says a message exists while the rail has no body for it. Slow Wi-Fi stretches that window from milliseconds to minutes, which is exactly the state you hit yesterday.\n\nProposal: the card renders rail-truth and represents the gap honestly instead of pretending the projection is renderable.",
  "Sol's back, and it corrected three things I told you an hour ago. Those first, since I asserted them.\n\nThe extractor does NOT force status over a user lock — the guard is in the SQL CASE. The reassignment event does reach the board store. And saved items already open the panel.\n\nWhat stands: the write-divergence finding, the ghost card, and the calls exclusion being four layers deep.",
  "Chunk 4 landed. The card renders the ledger: newest replies stay full rows, older ones collapse to lead lines that expand in place, and the mass above the window folds into one head row into the panel.\n\nThe monotone rule from the scroll-reveal work applies again: once a row renders full it never demotes, so an open edit buffer can't be unmounted by a new arrival.",
]

function workspaceIdFrom(page: Page): string {
  const match = page.url().match(/\/w\/(ws_[a-z0-9]+)/i)
  if (!match) throw new Error(`No workspace id in url ${page.url()}`)
  return match[1]
}

test("ledger board shots", async ({ page }) => {
  test.setTimeout(240_000)
  await loginAndCreateWorkspace(page, "ledger-shots")
  const workspaceId = workspaceIdFrom(page)
  // Brand-new workspace: the empty state's big button, not the section menu.
  await page.getByRole("button", { name: "+ New Scratchpad" }).click()
  await expect(page.locator("[data-editor-zone='main'] [contenteditable='true']").last()).toBeVisible({
    timeout: 15_000,
  })

  const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
  const send = async (text: string) => {
    await composer.click()
    const paragraphs = text.split("\n\n")
    for (let i = 0; i < paragraphs.length; i++) {
      if (i > 0) {
        await page.keyboard.press("Shift+Enter")
        await page.keyboard.press("Shift+Enter")
      }
      await composer.pressSequentially(paragraphs[i].replace(/\n/g, " "), { delay: 1 })
    }
    await page.keyboard.press("Enter")
    await page.waitForTimeout(400)
  }

  await send("Kicking off the ledger visual pass — this scratchpad stands in for a CC coding session.")
  for (let i = 0; i < 8; i++) {
    await send(LONG_BODIES[i % LONG_BODIES.length])
    if (i % 3 === 1) await send("Short steer from me: keep going, but bound the retries first.")
  }
  await send("Latest state: stack is green end to end, ten PRs linked, whole-stack review running.")

  // Board, desktop.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/w/${workspaceId}/board?lens=all`)
  await expect(page.locator("[data-ledger-row]").first()).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: ".tmp/shots-ledger/01-board-desktop.png" })

  // Expand one ledger row in place.
  await page.locator("[data-ledger-row]").nth(1).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: ".tmp/shots-ledger/02-board-desktop-expanded.png" })

  // Mobile.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: ".tmp/shots-ledger/03-board-mobile.png" })

  // Mobile scrolled to the card top (header + head row).
  const scroller = page.locator("[data-board-scroll-viewport]")
  await scroller.evaluate((el) => el.scrollTo(0, 0))
  await page.waitForTimeout(500)
  await page.screenshot({ path: ".tmp/shots-ledger/04-board-mobile-top.png" })
})
