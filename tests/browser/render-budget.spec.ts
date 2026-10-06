import { test, expect, type Page } from "@playwright/test"
import {
  createChannel,
  expectApiOk,
  generateTestId,
  loginAndCreateWorkspace,
  loginInNewContext,
  workspaceIdFromUrl,
} from "./helpers"
import { seedStream } from "./perf-fixtures"
import { installRenderCounter, measureRenders, type RenderSample } from "./render-counter"
import { RENDER_BUDGETS, type RenderBudgetAction } from "./render-budgets"

// A budget failure repeats on every attempt, so retrying it only delays the red.
test.describe.configure({ timeout: 300_000, retries: 0 })

const REPETITIONS = 5
const SEED_COUNT = 30
const TOP_COMPONENTS = 15
const BUDGETS_FILE = "tests/browser/render-budgets.ts"
const REPRO =
  "PLAYWRIGHT_PROD_FRONTEND=1 bunx playwright test tests/browser/render-budget.spec.ts --workers=1 --reporter=line"

async function postMessage(page: Page, workspaceId: string, streamId: string, content: string): Promise<void> {
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } }),
    `Post "${content}"`
  )
}

function streamIdFromUrl(page: Page): string {
  return page.url().match(/\/s\/([^/?]+)/)![1]!
}

function topComponents(sample: RenderSample): string {
  return Object.entries(sample.byComponent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_COMPONENTS)
    .map(([name, count]) => `    ${String(count).padStart(6)}  ${name}`)
    .join("\n")
}

function checkBudget(action: RenderBudgetAction, samples: RenderSample[]): void {
  const sorted = [...samples].sort((a, b) => a.renders - b.renders)
  const lowest = sorted[0]!
  const median = sorted[Math.floor(sorted.length / 2)]!
  const counts = samples.map((s) => s.renders)
  const { baseline, tolerance } = RENDER_BUDGETS[action]
  const max = Math.floor(baseline * (1 + tolerance))
  const min = Math.ceil(baseline * (1 - tolerance))
  console.log(
    `render-budget "${action}": lowest ${lowest.renders}, median ${median.renders} (samples ${counts.join(", ")}), baseline ${baseline}`
  )

  const facts = (judged: RenderSample, judgedAs: string): string => {
    const delta = Math.round(((judged.renders - baseline) / baseline) * 100)
    return [
      `Action: ${action}`,
      `Samples (component renders per repetition): ${counts.join(", ")}`,
      `Judged on ${judgedAs}: ${judged.renders}`,
      `Baseline: ${baseline}; allowed range ${min}..${max} (±${tolerance * 100}%); measured ${delta > 0 ? "+" : ""}${delta}%`,
      `Top ${TOP_COMPONENTS} components in that sample:\n${topComponents(judged)}`,
      `Baselines live in ${BUDGETS_FILE}.`,
      `Reproduce: ${REPRO}`,
      "Run the same command on main and compare the component lists to see what changed.",
      "Prod builds minify component names. Rerun without PLAYWRIGHT_PROD_FRONTEND=1 for readable names: the dev server's counts sit inside the same band.",
    ].join("\n")
  }

  // Stragglers from the previous action inflate a sample and a window that
  // closes early deflates one. The lowest sample is immune to the first and the
  // median to the second, so each direction is judged on the one it can trust.
  if (lowest.renders > max) {
    expect
      .soft(
        lowest.renders,
        `RENDER REGRESSION: "${action}" re-renders more components than its baseline.\n` +
          `${facts(lowest, "the lowest sample (every repetition is above the range)")}\n` +
          "Find what re-renders (the top components above point at it) and fix the fan-out. " +
          "Do not raise the baseline unless the PR justifies the extra renders."
      )
      .toBeLessThanOrEqual(max)
  } else if (median.renders < min) {
    expect
      .soft(
        median.renders,
        `RENDER IMPROVEMENT: "${action}" renders fewer components than its baseline.\n` +
          `${facts(median, "the median sample (most repetitions are below the range)")}\n` +
          `Lower the baseline for "${action}" in ${BUDGETS_FILE} to ${median.renders}.`
      )
      .toBeGreaterThanOrEqual(min)
  }
}

test("component render counts stay within their budgets", async ({ page, browser }) => {
  await installRenderCounter(page)
  const { testId } = await loginAndCreateWorkspace(page, "render-budget")
  const workspaceId = workspaceIdFromUrl(page)

  // A third stream takes the off-screen messages so the switch target's
  // timeline, and with it the switch's render count, stays the same size.
  const backgroundName = `rb-background-${testId}`
  await createChannel(page, backgroundName)
  const backgroundStreamId = streamIdFromUrl(page)

  const otherName = `rb-other-${testId}`
  await createChannel(page, otherName)
  const otherStreamId = streamIdFromUrl(page)
  await seedStream(page, workspaceId, otherStreamId, SEED_COUNT, `other-${testId}`)

  const mainName = `rb-main-${testId}`
  await createChannel(page, mainName)
  const mainStreamId = streamIdFromUrl(page)
  await seedStream(page, workspaceId, mainStreamId, SEED_COUNT, `main-${testId}`)

  // Incoming messages come from another member: the viewer's own messages skip
  // the unread raise, the Inbox arrival and the read commit that real traffic pays for.
  const sender = await loginInNewContext(browser, `rb-sender-${testId}@example.com`, `RB Sender ${testId}`)
  await expectApiOk(
    await sender.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: `RB Sender ${testId}` },
    }),
    "Sender joins the workspace"
  )
  for (const streamId of [mainStreamId, backgroundStreamId]) {
    await expectApiOk(
      await sender.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
      "Sender joins the channel"
    )
    await expect
      .poll(
        async () =>
          (
            await sender.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
              data: { streamId, content: `sender-ready-${generateTestId()}` },
            })
          ).status(),
        { timeout: 10_000, message: "the sender's first post should be accepted after joining" }
      )
      .toBe(201)
  }

  const timeline = page.getByTestId("stream-timeline")
  const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").first()
  const mainLink = page.locator(`a[href*="/s/${mainStreamId}"]`).first()
  const otherLink = page.locator(`a[href*="/s/${otherStreamId}"]`).first()
  const backgroundLink = page.locator(`a[href*="/s/${backgroundStreamId}"]`).first()
  const lastSeed = (prefix: string) =>
    timeline.getByText(`${prefix}-${testId} msg-${String(SEED_COUNT).padStart(4, "0")}`)

  const openStream = async (link: typeof mainLink, name: string, prefix: string) => {
    await link.click()
    await expect(page.getByRole("heading", { name: `#${name}`, level: 1 })).toBeVisible({ timeout: 15_000 })
    await expect(lastSeed(prefix)).toBeVisible({ timeout: 15_000 })
  }

  await page.reload()
  await expect(lastSeed("main")).toBeVisible({ timeout: 30_000 })
  await openStream(otherLink, otherName, "other")
  await openStream(mainLink, mainName, "main")

  const samples: Record<RenderBudgetAction, RenderSample[]> = {
    "type 5 characters": [],
    "incoming message in the open stream": [],
    "message in another stream": [],
    "switch stream (warm)": [],
  }

  const sendSamples: RenderSample[] = []

  for (let rep = 0; rep < REPETITIONS; rep++) {
    const typed = `say-${rep}`
    await composer.click()
    samples["type 5 characters"].push(
      await measureRenders(page, "type 5 characters", async () => {
        await composer.pressSequentially(typed, { delay: 100 })
        await expect(composer).toHaveText(typed)
      })
    )

    // Reported, not gated: under CPU contention a send intermittently re-renders
    // every mounted timeline row (~4k renders become ~9k), so no band holds it.
    sendSamples.push(
      await measureRenders(page, "send a message", async () => {
        await page.keyboard.press("Enter")
        await expect(timeline.getByText(typed, { exact: true })).toBeVisible()
        await expect(composer).toHaveText("")
      })
    )

    const incoming = `incoming-${rep}-${generateTestId()}`
    samples["incoming message in the open stream"].push(
      await measureRenders(page, "incoming message in the open stream", async () => {
        // The read commit trails the row by a debounce plus a round trip, which
        // can outlast the quiet window; its renders belong to this action.
        const readCommit = page.waitForResponse(
          (r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith(`/streams/${mainStreamId}/read`)
        )
        await postMessage(sender.page, workspaceId, mainStreamId, incoming)
        await expect(timeline.getByText(incoming, { exact: true })).toBeVisible()
        await readCommit
      })
    )

    const elsewhere = `elsewhere-${rep}-${generateTestId()}`
    samples["message in another stream"].push(
      await measureRenders(page, "message in another stream", async () => {
        await postMessage(sender.page, workspaceId, backgroundStreamId, elsewhere)
        await expect(backgroundLink).toContainText(elsewhere)
      })
    )

    samples["switch stream (warm)"].push(
      await measureRenders(page, "switch stream (warm)", () => openStream(otherLink, otherName, "other"))
    )
    await openStream(mainLink, mainName, "main")
  }

  console.log(`render-budget "send a message" (not gated): ${sendSamples.map((s) => s.renders).join(", ")}`)
  for (const action of Object.keys(samples) as RenderBudgetAction[]) checkBudget(action, samples[action])
  await sender.context.close()
})
