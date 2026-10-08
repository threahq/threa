import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * A section's header never scrolls: as the panel narrows, the labels fold
 * first, then trailing tabs fold into a "+N" menu, while the tab on show, the
 * header's icons and "In this stream" stay put.
 */

test.describe.configure({ timeout: 120_000 })

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

async function seedThreads(page: Page, count: number) {
  await loginAndCreateWorkspace(page, "panel-header")
  await createChannel(page, `header-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const threads: string[] = []
  for (let index = 0; index < count; index++) {
    const parentId = await post(page, workspaceId, streamId, `parent number ${index + 1}`)
    const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "thread", parentStreamId: streamId, parentAnchorId: parentId },
    })
    await expectApiOk(response, "create thread")
    const threadId = ((await response.json()) as { stream: { id: string } }).stream.id
    await post(page, workspaceId, threadId, `reply in thread ${index + 1}`)
    threads.push(threadId)
  }
  return { workspaceId, streamId, threads }
}

async function labelStream(page: Page, workspaceId: string, streamId: string) {
  const created = await page.request.post(`/api/workspaces/${workspaceId}/labels`, {
    data: { name: "Urgent", color: "#dc2626" },
  })
  await expectApiOk(created, "create label")
  const labelId = ((await created.json()) as { label: { id: string } }).label.id
  const assigned = await page.request.post(`/api/workspaces/${workspaceId}/labels/${labelId}/assignments`, {
    data: { resourceType: "stream", resourceId: streamId },
  })
  await expectApiOk(assigned, "assign label")
}

const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)

/** The tab row as painted once a resize has settled. */
function settledRow(pane: Locator) {
  return pane.evaluate(async (el) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const strip = el.querySelector('nav[aria-label="Panel tabs"]')!
    const labels = el.querySelector('[aria-label^="1 label"]')
    return {
      shown: strip.querySelectorAll("a").length,
      more: strip.querySelector('button[aria-label*="more tab"]')?.textContent ?? null,
      labels: labels !== null && getComputedStyle(labels).visibility === "visible",
      overflows: strip.scrollWidth > strip.clientWidth,
    }
  })
}
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")

test("should fold the labels, then trailing tabs into +N, as the panel narrows without moving its icons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 4)
  const last = threads[3]
  await labelStream(page, workspaceId, last)

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threads.join(".")}`)
  const pane = tabPane(page, last)
  await expect(pane.getByText("reply in thread 4")).toBeVisible({ timeout: 30_000 })
  const header = pane.locator("header")
  const strip = pane.getByRole("navigation", { name: "Panel tabs" })
  const labels = pane.getByRole("button", { name: /1 label: Urgent/ })
  const more = strip.getByRole("button", { name: /more tabs?$/ })
  const resize = page.getByRole("separator", { name: "Resize thread panel" })
  const panelWidth = async () => (await pane.boundingBox())!.width

  // The panel keeps its stored width at any viewport; widen it until everything fits.
  for (let step = 0; step < 40 && !(await labels.isVisible()); step++) {
    const before = await panelWidth()
    await resize.focus()
    await page.keyboard.press("Shift+ArrowLeft")
    await expect.poll(panelWidth).not.toBe(before)
  }
  await expect(strip.getByRole("link")).toHaveCount(4)
  await expect(labels).toBeVisible()
  await expect(more).toHaveCount(0)

  // The icons' distance from the header's right edge.
  const iconOffsets = () =>
    header.evaluate((el) => {
      const right = el.getBoundingClientRect().right
      return ["In this stream", "Stream actions"].map((name) => {
        const icon = el.querySelector(`[aria-label="${name}"]`)
        return icon ? Math.round(right - icon.getBoundingClientRect().right) : null
      })
    })
  const offsets = await iconOffsets()
  expect(offsets.every((offset) => offset !== null)).toBe(true)

  const seen = new Set<string>()
  let previous = await panelWidth()
  for (let step = 0; step < 200; step++) {
    await resize.focus()
    await page.keyboard.press("ArrowRight")
    const width = await panelWidth()
    if (width >= previous) break
    previous = width

    // Nothing scrolls, the tab on show is never folded, and the icons hold still.
    const row = await settledRow(pane)
    expect(row.overflows).toBe(false)
    expect(row.more).toBe(row.shown < 4 ? `+${4 - row.shown}` : null)
    // Labels fold before any tab does.
    if (row.shown < 4) expect(row.labels).toBe(false)
    await expect(strip.locator('[aria-current="page"]')).toBeVisible()
    await expect(pane.getByRole("button", { name: "In this stream" })).toBeVisible()
    expect(await iconOffsets()).toEqual(offsets)
    seen.add(`${row.labels ? "labels" : "no-labels"}:${row.shown}`)
  }
  expect(seen.has("no-labels:4")).toBe(true)
  expect([...seen].some((state) => state.startsWith("no-labels:") && !state.endsWith(":4"))).toBe(true)

  // Widening brings the tabs back, then the labels.
  for (let step = 0; step < 40; step++) {
    const before = await panelWidth()
    await resize.focus()
    await page.keyboard.press("Shift+ArrowLeft")
    if ((await settledRow(pane)).labels) break
    await expect.poll(panelWidth).not.toBe(before)
  }
  expect(await settledRow(pane)).toEqual({ shown: 4, more: null, labels: true, overflows: false })
  await resize.focus()
  for (let step = 0; step < 200 && (await strip.getByRole("link").count()) === 4; step++) {
    await page.keyboard.press("ArrowRight")
  }

  // A folded tab comes forward from the menu, by keyboard, and takes focus in the row.
  const shownBefore = await strip.getByRole("link").allTextContents()
  await more.focus()
  await page.keyboard.press("Enter")
  const item = page.getByRole("menuitem").first()
  await expect(item).toBeFocused()
  const title = (await item.textContent())!
  expect(shownBefore).not.toContain(title)
  await page.keyboard.press("Enter")
  const number = title.match(/\d+/)![0]
  const front = threads[Number(number) - 1]
  await expect(tabPane(page, front).getByText(`reply in thread ${number}`)).toBeVisible()
  const frontTab = tabPane(page, front).getByRole("navigation", { name: "Panel tabs" }).locator('[aria-current="page"]')
  await expect(frontTab).toHaveText(title)
  await expect(frontTab).toBeFocused()
  expect(panelParam(page)).toContain(`${front}*`)
})

test("should land keyboard focus on the panel's close button when closing down to one tab", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const [first, second] = threads

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${first}.${second}`)
  await expect(tabPane(page, second).getByText("reply in thread 2")).toBeVisible({ timeout: 30_000 })

  const strip = tabPane(page, second).getByRole("navigation", { name: "Panel tabs" })
  await strip.getByRole("button", { name: "Close tab" }).last().focus()
  await page.keyboard.press("Enter")

  // Focusing into the tab made it the route's stream, so closing it hands the route to the tab left.
  await expect
    .poll(() => ({ stream: new URL(page.url()).pathname.split("/s/")[1], panel: panelParam(page) }))
    .toEqual({ stream: first, panel: `${streamId}-${first}` })
  await expect(tabPane(page, first).getByRole("button", { name: "Close", exact: true })).toBeFocused()
})

test("should keep the tab on show, its close and +N in a split section at its narrowest", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 4)
  const [lone, ...stacked] = threads

  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${lone}-${stacked.join(".")}`)
  await expect(tabPane(page, stacked[2]).getByText("reply in thread 4")).toBeVisible({ timeout: 30_000 })
  await expect(tabPane(page, lone).getByText("reply in thread 1")).toBeVisible()
  const divider = page.getByRole("separator", { name: "Resize panels side by side" })

  // Each side in turn at its narrowest.
  for (const [key, narrowed] of [
    ["ArrowRight", stacked[2]],
    ["ArrowLeft", lone],
  ] as const) {
    await divider.focus()
    let previous = -1
    for (let step = 0; step < 200; step++) {
      const value = Number(await divider.getAttribute("aria-valuenow"))
      if (value === previous) break
      previous = value
      await page.keyboard.press(`Shift+${key}`)
    }
    const pane = tabPane(page, narrowed)
    const strip = pane.getByRole("navigation", { name: "Panel tabs" })
    const row = await settledRow(pane)
    expect(row.overflows).toBe(false)
    expect(row.more).toBe(narrowed === lone ? null : `+${3 - row.shown}`)
    await expect(strip.locator('[aria-current="page"]')).toBeInViewport({ ratio: 1 })
    await expect(strip.getByRole("button", { name: "Close tab" }).last()).toBeInViewport({ ratio: 1 })
    if (row.more) await expect(strip.getByRole("button", { name: /more tabs?$/ })).toBeInViewport({ ratio: 1 })
  }
})

test("should keep each pane's title at 900px with a thread open, folding the stream's view icons into its menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 })
  const { workspaceId, streamId, threads } = await seedThreads(page, 1)
  await page.goto(`/w/${workspaceId}/s/${streamId}?panel=${threads[0]}`)
  await expect(tabPane(page, threads[0]).getByText("reply in thread 1")).toBeVisible({ timeout: 30_000 })

  const mainHeader = page.locator('div:has(> [data-editor-zone="main"]) > header')
  const title = mainHeader.getByRole("heading", { level: 1 })
  await expect(title).toBeInViewport({ ratio: 1 })
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(80)
  await expect(tabPane(page, threads[0]).locator("header").getByText("Thread", { exact: true })).toBeInViewport({
    ratio: 1,
  })

  // Folded, not gone: "In this stream" rides in the stream's menu.
  await expect(mainHeader.getByRole("button", { name: "In this stream" })).toHaveCount(0)
  await mainHeader.getByRole("button", { name: "Stream actions" }).focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: /In this stream/ }).click()
  await expect(page.getByRole("region", { name: "In this stream" })).toBeVisible()
})

test("should give every tabbed pane header one actions menu, the strip's or the pane's own", async ({ page }) => {
  test.setTimeout(240_000)
  const { workspaceId, streamId, threads } = await seedThreads(page, 2)
  const conversations: string[] = []
  for (const topic of ["first topic", "second topic"]) {
    const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: topic, conversation: { intent: "new" } },
    })
    await expectApiOk(response, `post ${topic}`)
    conversations.push(((await response.json()) as { conversationId: string }).conversationId)
  }
  const draftParent = await post(page, workspaceId, streamId, "parent of a draft thread")
  const [conversationA, conversationB] = conversations

  const layouts = [
    `board?panel=conv:${conversationA}.conv:${conversationB}*`,
    `board?panel=${threads[0]}.${threads[1]}*`,
    `s/${streamId}?panel=${threads[0]}.conv:${conversationA}*`,
    `s/${streamId}?panel=${threads[0]}.context:${streamId}*`,
    `s/${streamId}?panel=${threads[0]}.draft:${streamId}:${draftParent}*`,
    `s/${streamId}?panel=${threads[0]}.compose:${streamId}*`,
    `s/${streamId}?panel=${threads[0]}.convs:${streamId}*`,
  ]
  for (const layout of layouts) {
    await page.goto(`/w/${workspaceId}/${layout}`, { waitUntil: "commit" })
    const tabbedHeader = page.locator("header", { has: page.getByRole("button", { name: "Close tab" }) })
    await expect(tabbedHeader.getByRole("button", { name: "Focus pane" })).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            [...document.querySelectorAll("header")]
              .filter((header) => header.checkVisibility())
              .map(
                (header) =>
                  [...header.querySelectorAll("button")].filter(
                    (button) => button.checkVisibility() && button.querySelector("svg.lucide-ellipsis") !== null
                  ).length
              )
              .reduce((most, count) => Math.max(most, count), 0)
          ),
        { message: layout }
      )
      .toBe(1)
    await expect(tabbedHeader.getByRole("button", { name: /^(Tab|Stream|Conversation) actions$/ })).toHaveCount(1)
  }
})
