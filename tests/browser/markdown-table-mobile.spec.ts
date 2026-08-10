import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * A rendered markdown table at phone width — the one thing jsdom cannot answer.
 * Table layout is intrinsic sizing plus wrapping rules, and jsdom implements
 * neither, so "does a wide table stay readable or collapse into a column of
 * single characters" is unverifiable everywhere except a real engine.
 *
 * The table this asserts on is the shape that broke: short-label columns next
 * to inline code holding a branch name and a 40-char SHA, plus one prose cell.
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 800 }

/** No spaces, no hyphens: nothing for the line breaker to use. */
const UNBREAKABLE = "0123456789abcdef".repeat(6)

const TABLE_MARKDOWN = [
  "| PR | Branch | Current pushed head | Note |",
  "| --- | --- | --- | --- |",
  "| #1817 | `feat/invocation-source-mutations-01-canonical-state` | `923317a2548b04b2c5773ad9d2500afc405e1457` | short |",
  `| #1823 | \`${UNBREAKABLE}\` | \`88eb613f0ea1c2c8e505e1d8cf2040d5910c7e2e\` | a prose cell long enough that letting it size to its content would drag the table far past anything a thumb wants to scroll through, several clauses over |`,
].join("\n")

async function seedTable(page: Page, workspaceId: string, streamId: string): Promise<void> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: { streamId, content: TABLE_MARKDOWN },
  })
  await expectApiOk(response, "Send table message")
}

test("a wide table scrolls instead of crushing its columns", async ({ page }) => {
  await loginAndCreateWorkspace(page, "md-table")
  await createChannel(page, `table-${Date.now().toString(36)}`)

  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()

  await seedTable(page, workspaceId!, streamId!)
  await page.setViewportSize(PHONE)
  await page.reload()

  const table = page.locator("table").first()
  await expect(table).toBeVisible({ timeout: 30_000 })

  // The table sizes to its content and its own wrapper scrolls — the failure
  // this replaces had the table fit the message column exactly (no overflow)
  // by wrapping every cell down to one character per line.
  await expect.poll(() => table.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(PHONE.width)
  const scroller = await table.evaluateHandle((el) => el.parentElement!)
  expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

  // Nothing spills out of its cell, including the token with no break
  // opportunity in it, and no cell is narrower than a couple of characters.
  const cells = await table.evaluate((el) =>
    [...el.querySelectorAll("td, th")].map((cell) => {
      const box = cell.getBoundingClientRect()
      const content = [...cell.children].map((child) => child.getBoundingClientRect().right)
      return { width: Math.round(box.width), overflow: Math.max(0, ...content) - box.right }
    })
  )
  expect(Math.min(...cells.map((c) => c.width))).toBeGreaterThan(24)
  expect(Math.max(...cells.map((c) => c.overflow))).toBeLessThanOrEqual(1)

  // A table that overflows must not take the page with it.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true
  )
})
