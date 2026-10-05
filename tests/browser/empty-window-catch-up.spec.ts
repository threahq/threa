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

  await page.route(/\/streams\/stream_[^/]+\/bootstrap(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url())
    const after = url.searchParams.get("after")
    if (after !== null) url.searchParams.set("after", String(Math.max(1, Number(after) - 1)))
    const response = await route.fetch({ url: url.toString() })
    const body = (await response.json()) as { data: { events: unknown[] } }
    const data = after === null ? { ...body.data, events: [] } : body.data
    await route.fulfill({ response, json: { ...body, data } })
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
  const streamId = /\/s\/(stream_[^/?#]+)/.exec(scratchpadUrl)?.[1]
  await page
    .getByRole("link", { name: new RegExp(channel) })
    .first()
    .click()
  await expect(page).not.toHaveURL(scratchpadUrl)
  const catchUp = page.waitForResponse((response) => response.url().includes(`/streams/${streamId}/bootstrap?after=`))
  await page.goBack()
  const returned = (await (await catchUp).json()) as { data: { events: unknown[] } }
  expect(returned.data.events.length).toBeGreaterThan(0)
  await expect(timeline).toContainText("stub response from the companion")

  // Sampled rather than awaited: the page lands a few frames after its
  // response, and a retrying assertion would pass in the gap before it.
  const samples: boolean[] = []
  for (let sample = 0; sample < 8; sample++) {
    await page.waitForTimeout(250)
    samples.push(((await timeline.textContent()) ?? "").includes(MESSAGE))
  }
  expect(samples).toEqual(samples.map(() => true))
})
