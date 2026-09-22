import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 120_000 })

const PARAGRAPHS = (label: string) =>
  Array.from(
    { length: 5 },
    (_, i) => `${label} point ${i + 1}: the venue needs a room for twelve, a projector, and a quiet afternoon space.`
  ).join("\n\n")

function conversationId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  let out = "01M3"
  while (out.length < 26) out += alphabet[Math.floor(Math.random() * 32)]
  return `conv_${out}`
}

async function send(page: Page, workspaceId: string, streamId: string, content: string, conversation: object) {
  await expectApiOk(
    await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content, conversation } }),
    "send"
  )
}

/** One author, three tall messages in one conversation: a run that folds. */
async function seedTallRun(page: Page) {
  await loginAndCreateWorkspace(page, "run-fold")
  await createChannel(page, `run-fold-${Date.now().toString(36)}`)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamId = page.url().match(/\/s\/([^/?]+)/)![1]
  await expectApiOk(
    await page.request.patch(`/api/workspaces/${workspaceId}/preferences`, { data: { messageCollapseEnabled: true } }),
    "enable collapse"
  )

  const conversation = conversationId()
  await send(page, workspaceId, streamId, PARAGRAPHS("Alpha"), { intent: "new", conversationId: conversation })
  await send(page, workspaceId, streamId, PARAGRAPHS("Bravo"), { intent: "existing", conversationId: conversation })
  await send(page, workspaceId, streamId, PARAGRAPHS("Charlie"), { intent: "existing", conversationId: conversation })

  await expect(page.getByTestId("stream-timeline").getByText("Charlie point 5")).toBeVisible()
  return { workspaceId, streamId }
}

test("a tall same-author run opens folded to its head and toggles as one", async ({ page }) => {
  await seedTallRun(page)
  const timeline = page.getByTestId("stream-timeline")

  // Sample every frame of the reopen: the hidden members must never reach a
  // painted frame, so the fold is decided before the first paint.
  await page.addInitScript(() => {
    const frames: number[] = []
    ;(window as unknown as { __runFoldFrames: number[] }).__runFoldFrames = frames
    const sample = () => {
      const rows = document.querySelectorAll('[data-testid="stream-timeline"] [data-message-id]')
      let bravoOrCharlie = 0
      for (const row of rows) if (/Bravo|Charlie/.test(row.textContent ?? "")) bravoOrCharlie++
      if (rows.length > 0) frames.push(bravoOrCharlie)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.reload()

  const expand = timeline.getByRole("button", { name: "Show 2 more messages" })
  await expect(expand).toBeVisible()
  await expect(timeline.getByText("Alpha point 1")).toBeVisible()
  const frames = await page.evaluate(() => (window as unknown as { __runFoldFrames: number[] }).__runFoldFrames)
  expect({ sampled: frames.length > 0, maxHiddenRowsPainted: Math.max(0, ...frames) }).toEqual({
    sampled: true,
    maxHiddenRowsPainted: 0,
  })

  await expand.click()
  await expect(timeline.getByText("Charlie point 5")).toBeVisible()
  await expect(timeline.getByRole("button", { name: "Collapse", exact: true })).toHaveCount(1)

  await timeline.getByRole("button", { name: "Collapse", exact: true }).click()
  await expect(timeline.getByRole("button", { name: "Show 2 more messages" })).toBeVisible()
  await expect(timeline.getByText("Charlie point 1")).toHaveCount(0)
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test("collapsing a run from its tail brings the folded head back on screen", async ({ page }) => {
    const { workspaceId, streamId } = await seedTallRun(page)
    // Content below the run, so folding it can't just clamp the scroller to its end.
    for (const label of ["Delta", "Echo", "Foxtrot", "Golf"]) {
      await send(page, workspaceId, streamId, PARAGRAPHS(label), { intent: "new", conversationId: conversationId() })
    }
    await page.reload()
    const timeline = page.getByTestId("stream-timeline")

    const expand = timeline.getByRole("button", { name: "Show 2 more messages" })
    await expand.scrollIntoViewIfNeeded()
    await expand.click()
    const collapse = timeline.getByRole("button", { name: "Collapse", exact: true })
    await collapse.scrollIntoViewIfNeeded()
    await expect(timeline.getByText("Alpha point 1")).not.toBeInViewport()

    await collapse.click()
    await expect(timeline.getByRole("button", { name: "Show 2 more messages" })).toBeInViewport()
    await expect(timeline.getByText("Alpha point 1")).toBeInViewport()
  })
})
