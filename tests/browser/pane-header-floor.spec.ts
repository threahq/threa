import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, panesSettled } from "./helpers"

test.describe.configure({ timeout: 300_000 })

const FLOOR_WIDTH = 240
const FLOOR_HEIGHT = 120

async function post(page: Page, workspaceId: string, streamId: string, content: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
  return ((await response.json()) as { message: { id: string } }).message.id
}

const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)

/**
 * What is wrong with a header as painted: controls, icons and text that overlap
 * one another or spill out of it, an icon cut by a clipping parent, and text
 * truncated to nothing readable.
 */
function headerProblems(header: Locator): Promise<string[]> {
  return header.evaluate(async (root) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    type Box = { left: number; top: number; right: number; bottom: number }
    const bounds = root.getBoundingClientRect()
    const shown = (el: Element) => {
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0) return false
      return rect.width > 1.5 && rect.height > 1.5
    }
    const clipOf = (el: Element) => {
      const clip = { left: -Infinity, right: Infinity }
      for (let parent = el.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX === "visible") continue
        const rect = parent.getBoundingClientRect()
        clip.left = Math.max(clip.left, rect.left)
        clip.right = Math.min(clip.right, rect.right)
      }
      return clip
    }
    const nameOf = (el: Element) => {
      const owner = el.closest("button, a, [data-testid]") ?? el
      const name =
        owner.getAttribute("aria-label") ?? owner.getAttribute("data-testid") ?? owner.textContent?.trim().slice(0, 24)
      return `${el.tagName.toLowerCase()}[${name}]`
    }

    const items: { el: Element; box: Box; kind: "control" | "icon" | "text"; natural: number }[] = []
    for (const el of root.querySelectorAll("*")) {
      if (el.closest("svg") && el.tagName !== "svg") continue
      if (!shown(el) || el.closest(".sr-only")) continue
      const hasText = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim())
      const control = el.matches("button, a, input, [role=button]")
      if (!control && el.tagName !== "svg" && !hasText) continue
      let rect: Box = el.getBoundingClientRect()
      if (!control && hasText) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const rects = [...range.getClientRects()].filter((r) => r.width > 0)
        if (rects.length === 0) continue
        rect = {
          left: Math.min(...rects.map((r) => r.left)),
          right: Math.max(...rects.map((r) => r.right)),
          top: Math.min(...rects.map((r) => r.top)),
          bottom: Math.max(...rects.map((r) => r.bottom)),
        }
      }
      const natural = rect.right - rect.left
      if (!control && hasText && getComputedStyle(el).overflowX !== "visible") {
        const own = el.getBoundingClientRect()
        rect = { ...rect, left: Math.max(rect.left, own.left), right: Math.min(rect.right, own.right) }
      }
      const clip = clipOf(el)
      const box = { ...rect, left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right) }
      let kind: "control" | "icon" | "text" = "text"
      if (control) kind = "control"
      else if (el.tagName === "svg") kind = "icon"
      items.push({ el, box, kind, natural })
    }

    const problems = new Set<string>()
    for (const { el, box, kind, natural } of items) {
      const width = box.right - box.left
      if (kind === "icon" && width > 0 && width < natural - 0.5) problems.add(`cut ${nameOf(el)}`)
      if (kind === "text" && width < 14 && natural > width + 0.5) problems.add(`crushed ${nameOf(el)}`)
      if (width > 0 && (box.left < bounds.left - 0.5 || box.right > bounds.right + 0.5))
        problems.add(`outside ${nameOf(el)}`)
    }
    for (const [index, one] of items.entries()) {
      for (const other of items.slice(index + 1)) {
        if (one.el.contains(other.el) || other.el.contains(one.el)) continue
        const x = Math.min(one.box.right, other.box.right) - Math.max(one.box.left, other.box.left)
        const y = Math.min(one.box.bottom, other.box.bottom) - Math.max(one.box.top, other.box.top)
        if (x > 1 && y > 1) problems.add(`overlap ${nameOf(one.el)} x ${nameOf(other.el)}`)
      }
    }
    return [...problems]
  })
}

/**
 * Narrows `pane` ten pixels at a time with whichever divider moves it, until
 * none does. Returns the width it ends at and every header problem that held
 * at some width on the way.
 */
async function squeeze(page: Page, pane: Locator): Promise<{ narrowest: number; problems: string[] }> {
  await expect(pane).toBeVisible({ timeout: 10_000 })
  await panesSettled(page)
  const header = pane.locator("header").first()
  await expect(header).toBeVisible()
  const width = async () => Math.round((await pane.boundingBox())!.width)
  const problems = new Set<string>()
  const read = async () => {
    const at = await width()
    const seen = await headerProblems(header)
    if (seen.length > 0) {
      // A header refits a frame or two after its pane resizes; only what survives that counts.
      await page.waitForTimeout(250)
      const held = await headerProblems(header)
      for (const problem of seen) if (held.includes(problem)) problems.add(`${problem} at ${at}px`)
    }
    return at
  }

  let narrowest = await read()
  const dividers = page.getByRole("separator")
  for (let index = 0; index < (await dividers.count()); index++) {
    const divider = dividers.nth(index)
    if ((await divider.getAttribute("aria-orientation")) === "horizontal") continue
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      for (let step = 0; step < 200; step++) {
        const before = await width()
        await divider.focus()
        await page.keyboard.press(before > 600 ? `Shift+${key}` : key)
        await page.waitForTimeout(40)
        const after = await read()
        if (after > before) {
          await page.keyboard.press(key === "ArrowLeft" ? "ArrowRight" : "ArrowLeft")
          await page.waitForTimeout(40)
        }
        if (after >= before) break
        narrowest = after
      }
    }
  }
  return { narrowest, problems: [...problems] }
}

async function seedChannel(page: Page) {
  await loginAndCreateWorkspace(page, "header-floor")
  await createChannel(page, `a-channel-with-a-rather-long-name-${Date.now().toString(36)}`)
  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)![1]
  const streamId = url.match(/\/s\/([^/?]+)/)![1]
  const parentId = await post(page, workspaceId, streamId, "a parent message with quite a long opening line")
  const created = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "thread", parentStreamId: streamId, parentAnchorId: parentId },
  })
  await expectApiOk(created, "create thread")
  const threadId = ((await created.json()) as { stream: { id: string } }).stream.id
  await post(page, workspaceId, threadId, "reply in the thread")
  return { base: `/w/${workspaceId}/s/${streamId}`, streamId, threadId }
}

test("should keep every pane header's controls apart, whole and inside it, down to the narrowest a pane gets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { base, streamId, threadId } = await seedChannel(page)

  const tabbed = (id: string) => `${threadId}.${id}`
  const cases: Record<string, { layout: string; id: string }> = {
    "channel in its own column": { layout: `page:drafts-${streamId}-page:search`, id: streamId },
    "channel in a tab row": { layout: `page:drafts-${tabbed(streamId)}-page:search`, id: streamId },
    "thread in its own column": { layout: `${streamId}-${threadId}-page:search`, id: threadId },
    "Saved in its own column": { layout: `${streamId}-page:saved-page:search`, id: "page:saved" },
    "Saved in a tab row": { layout: `${streamId}-${tabbed("page:saved")}-page:search`, id: "page:saved" },
    "Streams in its own column": { layout: `${streamId}-page:streams-page:search`, id: "page:streams" },
    "Search in its own column": { layout: `${streamId}-page:search-page:files`, id: "page:search" },
    "Search in a tab row": { layout: `${streamId}-${tabbed("page:search")}-page:files`, id: "page:search" },
    "Memory in a tab row": { layout: `${streamId}-${tabbed("page:memory")}-page:search`, id: "page:memory" },
    "Board in its own column": { layout: `${streamId}-page:board-page:search`, id: "page:board" },
  }

  const found: Record<string, { narrowest: number; problems: string[] }> = {}
  for (const [name, { layout, id }] of Object.entries(cases)) {
    await page.goto(`${base}?panel=${layout}`)
    found[name] = await squeeze(page, tabPane(page, id))
  }

  // The aside's column is its own when another column stands beside it.
  await page.goto(base)
  await page.getByTestId("aside-header-chip").first().click()
  const aside = page.getByTestId("aside-panel")
  await expect(aside).toBeVisible()
  await page.evaluate(() => {
    const url = new URL(location.href)
    url.searchParams.set("panel", `${url.searchParams.get("panel")}-page:files`)
    history.pushState(history.state, "", url)
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }))
  })
  await expect(tabPane(page, "page:files")).toBeVisible()
  found["aside in its own column"] = await squeeze(page, aside)

  const clean = { narrowest: FLOOR_WIDTH, problems: [] }
  expect(found).toEqual(
    Object.fromEntries([...Object.keys(cases), "aside in its own column"].map((name) => [name, clean]))
  )
})

test("should hold every pane at its least width and height when the window shrinks under a squeezed layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { base, streamId, threadId } = await seedChannel(page)
  await page.goto(`${base}?panel=${streamId}-${threadId}--page:files-page:search`)
  const panes = [threadId, "page:files", "page:search"].map((id) => tabPane(page, id))
  await squeeze(page, panes[2])
  const rowDivider = page.getByRole("separator").and(page.locator('[aria-orientation="horizontal"]'))
  await rowDivider.focus()
  for (let step = 0; step < 20; step++) await page.keyboard.press("Shift+ArrowDown")
  await panesSettled(page)
  const sizes = async () =>
    (await Promise.all(panes.map((pane) => pane.boundingBox()))).map((box) => ({
      width: Math.round(box!.width),
      height: Math.round(box!.height),
    }))
  const squeezed = await sizes()
  expect([squeezed[1].height, squeezed[2].width]).toEqual([FLOOR_HEIGHT, FLOOR_WIDTH])

  await page.setViewportSize({ width: 1300, height: 700 })
  await panesSettled(page)

  const shrunk = await sizes()
  expect({
    columns: new Set(shrunk.map((size) => size.width)).size,
    files: shrunk[1].height,
    search: shrunk[2].width,
  }).toEqual({
    columns: 2,
    files: FLOOR_HEIGHT,
    search: FLOOR_WIDTH,
  })
})

test("should keep what a squeezed header gave up within reach, and its search field the same field", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { base, streamId, threadId } = await seedChannel(page)
  const offered = async (trigger: Locator) => {
    await trigger.click()
    const items = page.getByRole("menuitem")
    await expect(items.first()).toBeVisible()
    const labels = await items.allTextContents()
    await page.keyboard.press("Escape")
    return labels.map((label) => label.trim())
  }

  await page.goto(`${base}?panel=page:drafts-${streamId}-page:search`)
  const channel = tabPane(page, streamId)
  await squeeze(page, channel)
  const streamActions = await offered(channel.getByRole("button", { name: "Stream actions" }))

  await page.goto(`${base}?panel=${streamId}-${threadId}.page:saved-page:search`)
  const saved = tabPane(page, "page:saved")
  await squeeze(page, saved)
  const moreTabs = await offered(saved.getByRole("button", { name: /more tabs?$/ }))

  await page.goto(`${base}?panel=${streamId}-page:search-page:files`)
  const field = tabPane(page, "page:search").getByLabel("Search messages", { exact: true })
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.click()
  await page.keyboard.type("floor")
  await field.evaluate((el) => el.setAttribute("data-squeezed", ""))
  const inHeaderRow = () =>
    field.evaluate((el) => el.getBoundingClientRect().top < el.closest("header")!.getBoundingClientRect().bottom)
  const wide = await inHeaderRow()
  await squeeze(page, tabPane(page, "page:search"))

  expect({
    streamActions,
    moreTabs,
    field: {
      wide,
      squeezed: await inHeaderRow(),
      kept: await field.getAttribute("data-squeezed"),
      text: await field.innerText(),
    },
  }).toEqual({
    streamActions: expect.arrayContaining(["Start voice call", "Start video call", "Search in conversation"]),
    moreTabs: expect.arrayContaining(["Split right", "Split down"]),
    field: { wide: true, squeezed: false, kept: "", text: "floor" },
  })
})
