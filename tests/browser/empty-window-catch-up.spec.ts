import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, createScratchpadFromSidebar, generateTestId } from "./helpers"

/**
 * A new stream's window is fetched before its first message exists, so it
 * opens empty. A later catch-up page that starts above that message must not
 * become the timeline's lower bound: the message was sent in this window and
 * stays on screen.
 *
 * Both halves of the race are pinned through the network: every full window
 * comes back empty, and the catch-up cursor is pulled back one event so the
 * page always carries something.
 */

test.describe.configure({ timeout: 120_000 })

const MESSAGE = "First message in an empty window"

test("a catch-up page never hides a message sent into a window that opened empty", async ({ page }) => {
  // Tall enough that the virtualizer keeps every row mounted: a row scrolled
  // out of a short viewport reads exactly like a hidden one.
  await page.setViewportSize({ width: 1280, height: 2200 })
  await loginAndCreateWorkspace(page)

  const catchUpSequences: string[][] = []
  await page.route(/\/streams\/stream_[^/]+\/bootstrap(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url())
    const after = url.searchParams.get("after")
    if (after !== null) url.searchParams.set("after", String(Math.max(1, Number(after) - 1)))
    const response = await route.fetch({ url: url.toString() })
    const body = (await response.json()) as { data: { events: { sequence: string }[] } }
    if (after === null) {
      await route.fulfill({ response, json: { ...body, data: { ...body.data, events: [] } } })
      return
    }
    catchUpSequences.push(body.data.events.map((event) => event.sequence))
    await route.fulfill({ response, json: body })
  })

  const channel = `floor-${generateTestId()}`
  await createChannel(page, channel, { switchToAll: false })
  await createScratchpadFromSidebar(page)
  await expect(page).toHaveURL(/\/s\/draft_/, { timeout: 10000 })

  const editor = page.locator("[contenteditable='true']").first()
  await editor.click()
  await editor.pressSequentially(MESSAGE)
  await expect(editor).toContainText(MESSAGE, { timeout: 10000 })
  await page.getByRole("button", { name: "Send", exact: true }).first().click()
  await expect(page).toHaveURL(/\/s\/stream_/, { timeout: 20000 })

  const timeline = page.getByTestId("stream-timeline")
  await expect(timeline).toContainText(MESSAGE)
  await expect(timeline).toContainText("stub response from the companion", { timeout: 30000 })

  const scratchpadUrl = page.url()
  await page
    .getByRole("link", { name: new RegExp(channel) })
    .first()
    .click()
  await expect(page).not.toHaveURL(scratchpadUrl)
  const settledBefore = catchUpSequences.length
  const catchUp = page.waitForResponse((response) => /\/bootstrap\?after=/.test(response.url()))
  await page.goBack()
  await catchUp
  await expect(timeline).toContainText("stub response from the companion")
  await page.waitForTimeout(500)

  expect({
    returnPageCarriedEvents: catchUpSequences.slice(settledBefore).flat().length > 0,
    anyPageCarriedTheMessage: catchUpSequences.flat().includes("1"),
  }).toEqual({ returnPageCarriedEvents: true, anyPageCarriedTheMessage: false })
  await expect(timeline).toContainText(MESSAGE)
})
