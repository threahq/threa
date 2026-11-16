import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"

/**
 * Until a stream's window bootstrap lands, the timeline shows the newest page
 * cached on the device, so every live event slides the window's start down by
 * one. When a bot session starts or finishes there, two things change in one
 * update: the run group at the top loses its oldest session (same index, new
 * key) and a row appears or merges at the bottom. Every row in between keeps
 * its index while the count changes; a shifted virtua update would hand each
 * of them its neighbour's cached height and never re-measure, so a tall bot
 * answer gets drawn under the run-group card below it.
 */

test.describe.configure({ timeout: 240_000 })
test.use({ viewport: { width: 412, height: 780 }, hasTouch: true, isMobile: true })

const TALL_ANSWER = Array.from(
  { length: 14 },
  (_, i) => `- line ${i + 1} of a long bot answer with enough words to wrap`
).join("\n")

async function setupBotRuntime(page: Page, workspaceId: string, testId: string) {
  const botRes = await page.request.post(`/api/workspaces/${workspaceId}/bots`, {
    data: {
      type: "personal",
      name: `Runner ${testId}`,
      slug: `runner-${testId}`,
      traits: ["active-scratchpad", "mentionable"],
    },
  })
  expect(botRes.status(), await botRes.text()).toBe(201)
  const botId = ((await botRes.json()) as { data: { id: string } }).data.id
  const keyRes = await page.request.post(`/api/workspaces/${workspaceId}/bots/${botId}/keys`, {
    data: { name: "runner", scopes: ["bot-runtime:write", "bot-invocations:write"] },
  })
  expect(keyRes.status(), await keyRes.text()).toBe(201)
  const headers = { Authorization: `Bearer ${((await keyRes.json()) as { value: string }).value}` }
  const instanceId = `inst-${testId}`
  const runtimeSessionId = `sess-${testId}`
  const sessionRes = await page.request.post(`/api/v1/workspaces/${workspaceId}/bot-runtime/sessions`, {
    headers,
    data: { runtimeKind: "t3code", instanceId, runtimeSessionId, displayName: `Runner ${testId}` },
  })
  expect(sessionRes.status(), await sessionRes.text()).toBe(200)
  const streamId = ((await sessionRes.json()) as { data: { activeStreamId: string } }).data.activeStreamId

  let runs = 0
  /** Starts a bot session; the returned function finishes it, with an answer or without. */
  const start = async (answer?: string) => {
    runs++
    const adopt = await page.request.post(`/api/v1/workspaces/${workspaceId}/bot-invocations/adopt`, {
      headers,
      data: {
        instanceId,
        runtimeSessionId,
        responseStreamId: streamId,
        externalRunId: `run-${testId}-${runs}`,
        attachmentRequestId: `att-${testId}-${runs}`,
      },
    })
    expect(adopt.status(), await adopt.text()).toBeLessThan(300)
    const { invocation } = ((await adopt.json()) as { data: { invocation: { id: string; claimToken: string } } }).data
    return async () => {
      const res = await page.request.post(
        `/api/v1/workspaces/${workspaceId}/bot-invocations/${invocation.id}/complete`,
        {
          headers,
          data: answer
            ? { instanceId, claimToken: invocation.claimToken, finalMessageMarkdown: answer }
            : { instanceId, claimToken: invocation.claimToken, noResponse: true },
        }
      )
      expect(res.status(), await res.text()).toBeLessThan(300)
    }
  }
  const session = async (answer?: string) => (await start(answer))()
  return { streamId, start, session }
}

/** Pairs of mounted timeline rows whose boxes overlap, in screen order. */
function overlappingRows(page: Page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>("main [data-timeline-rows] > div > div")]
      .map((row) => ({ row, box: row.getBoundingClientRect() }))
      .filter(({ box }) => box.height > 0)
      .sort((a, b) => a.box.top - b.box.top)
    const overlaps: { px: number; upper: string; lower: string }[] = []
    for (let i = 0; i + 1 < rows.length; i++) {
      const px = Math.round(rows[i].box.bottom - rows[i + 1].box.top)
      if (px > 1) {
        overlaps.push({
          px,
          upper: rows[i].row.textContent?.slice(0, 40) ?? "",
          lower: rows[i + 1].row.textContent?.slice(0, 40) ?? "",
        })
      }
    }
    return overlaps
  })
}

test("rows keep their own height while bot sessions land under a sliding cached window", async ({ page }) => {
  const { testId } = await loginAndCreateWorkspace(page, "rungroup")
  const workspaceId = workspaceIdFromUrl(page)
  const bot = await setupBotRuntime(page, workspaceId, testId)
  // More than one cached page of events (two per session), with the oldest
  // page starting inside a run group so the window's start is a group card.
  for (let i = 0; i < 12; i++) await bot.session()
  await bot.session(TALL_ANSWER)
  for (let i = 0; i < 10; i++) await bot.session()
  await bot.session(TALL_ANSWER)
  await bot.session()

  const rows = page.getByRole("main").locator(".message-item")
  await page.goto(`/w/${workspaceId}/s/${bot.streamId}`)
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })

  // Hold the window bootstrap so the reopened stream renders from the device
  // cache, the state a phone sits in while the network catches up.
  await page.route(/\/streams\/[^/]+\/bootstrap(?!.*after=)/, () => {})
  await page.reload()
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_000)
  // Read history: scroll up past the follow band so the list stops following the tail.
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("main [data-suppress-pull-refresh]")!
    scroller.scrollTop -= 250
  })

  const working = page.getByRole("main").getByText("is working")
  for (let cycle = 0; cycle < 3; cycle++) {
    const finish = await bot.start()
    await expect(working).toHaveCount(1, { timeout: 60_000 })
    await finish()
    await expect(working).toHaveCount(0, { timeout: 30_000 })
    await page.waitForTimeout(300)
    expect(await overlappingRows(page), `after session ${cycle + 1}`).toEqual([])
  }
})
