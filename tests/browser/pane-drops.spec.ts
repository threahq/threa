import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk, panesSettled, at, drag } from "./helpers"

/**
 * A sidebar row or a tab dropped on the stream page lands where it was
 * dropped: a pane's edge splits beside it, a tab strip splices between its
 * tabs, and the stream dropped in is the one the route names. The composer
 * keeps its link drop.
 */

test.describe.configure({ timeout: 120_000 })

declare global {
  interface Window {
    /** Holds each glide at its midpoint from its first frame. */
    __holdGlides?: boolean
  }
}

async function post(page: Page, workspaceId: string, streamId: string, content: string) {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } })
  await expectApiOk(response, `post ${content}`)
}

const streamIdOf = (page: Page) => page.url().match(/\/s\/([^/?]+)/)![1]

async function seed(page: Page) {
  await loginAndCreateWorkspace(page, "pane-drops")
  const suffix = Date.now().toString(36)
  const names = { a: `drop-a-${suffix}`, b: `drop-b-${suffix}`, c: `drop-c-${suffix}` }
  await createChannel(page, names.b)
  const streamB = streamIdOf(page)
  await createChannel(page, names.c)
  const streamC = streamIdOf(page)
  await createChannel(page, names.a)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streamA = streamIdOf(page)
  await post(page, workspaceId, streamA, "said in a")
  await post(page, workspaceId, streamB, "said in b")
  await post(page, workspaceId, streamC, "said in c")
  await page.reload()
  await expect(page.getByRole("main").getByText("said in a")).toBeVisible({ timeout: 30_000 })
  return { names, streamA, streamB, streamC }
}

const sidebarRow = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Sidebar navigation" }).getByRole("link", { name: `#${name}` })
const tabPane = (page: Page, id: string) => page.locator(`[data-panel-tab="${id}"]`)
const tabLink = (page: Page, pane: string, id: string) =>
  tabPane(page, pane).getByRole("navigation", { name: "Panel tabs" }).locator(`[data-tab-id="${id}"] a`)
const mainPane = (page: Page) => page.getByTestId("main-pane")
const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")

/** `at`, once the panes have stopped gliding and `target` holds still. */
async function settledAt(target: Locator, x: number, y: number) {
  await settled(target)
  return at(target, x, y)
}

/** Resolves once the panes have stopped gliding and `target` holds still. */
async function settled(target: Locator) {
  await panesSettled(target.page())
  let last = ""
  await expect
    .poll(async () => {
      const box = JSON.stringify(await target.boundingBox())
      const still = box === last
      last = box
      return still
    })
    .toBe(true)
}

async function tag(target: Locator, name: string) {
  await target.first().evaluate((el, n) => {
    ;(el as unknown as Record<string, string>).__dropTag = n
  }, name)
}

async function tagOf(target: Locator): Promise<string | null> {
  return target.first().evaluate((el) => (el as unknown as Record<string, string>).__dropTag ?? null)
}

/** Lets a page hold each glide at its midpoint from its first frame, while `__holdGlides` is set. */
async function holdableGlides(page: Page) {
  await page.addInitScript(() => {
    const animate = Element.prototype.animate
    Element.prototype.animate = function (this: Element, ...args) {
      const animation = animate.apply(this, args)
      if (animation.id === "pane-glide" && window.__holdGlides) {
        animation.pause()
        animation.currentTime = 120
      }
      return animation
    }
  })
}

const holdGlides = (page: Page) =>
  page.evaluate(() => {
    window.__holdGlides = true
  })

const releaseGlides = (page: Page) =>
  page.evaluate(() => {
    window.__holdGlides = false
    for (const animation of document.getAnimations()) if (animation.id === "pane-glide") animation.finish()
  })

/** Main's width, and how far the divider beside it stands off its right edge. */
const mainEdge = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector("[data-testid='main-pane']")!.getBoundingClientRect()
    const dividers = [...document.querySelectorAll("[data-testid='main-pane'] ~ [role='separator']")]
    return {
      main: Math.round(main.width),
      dividers: dividers.map((divider) => Math.round(Math.abs(divider.getBoundingClientRect().left - main.right))),
    }
  })

/** The glide animations running, each by whether the pane host or one of its children holds it. */
const glides = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector("[data-testid='main-pane']")!.parentElement!
    return document
      .getAnimations()
      .filter((animation) => animation.id === "pane-glide")
      .map((animation) => {
        const target = (animation.effect as KeyframeEffect).target
        return target === host ? "host" : host.contains(target) ? "child" : "elsewhere"
      })
  })

/** How far down the page `id`'s pane starts, and how far each row divider stands off its top edge. */
const topEdge = (page: Page, id: string) =>
  page.evaluate((id) => {
    const pane = document.querySelector(`[data-panel-tab="${id}"]`)!
    const top = pane.getBoundingClientRect().top
    const dividers = [...pane.parentElement!.querySelectorAll(":scope > [aria-orientation='horizontal']")]
    return {
      top: Math.round(top - pane.parentElement!.getBoundingClientRect().top),
      dividers: dividers.map((divider) => Math.round(Math.abs(divider.getBoundingClientRect().top - top))),
    }
  }, id)

test("should open a dropped pane at the size its drop zone showed", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  const { names, streamA, streamB, streamC } = await seed(page)
  const indicator = page.getByTestId("pane-drop-indicator")
  let zone = { width: 0, height: 0 }
  const shows = (side: string) => async () => {
    await expect(indicator).toHaveAttribute("data-drop", side)
    zone = (await indicator.boundingBox())!
  }
  const sizeOf = async (pane: Locator) => {
    const box = (await pane.boundingBox())!
    return { width: Math.round(box.width), height: Math.round(box.height) }
  }
  const near = (size: number) => ({ size, within: (actual: number) => Math.abs(actual - size) <= 2 })
  const expectSize = async (pane: Locator, axis: "width" | "height") => {
    const expected = near(zone[axis])
    await expect.poll(async () => expected.within((await sizeOf(pane))[axis])).toBe(true)
  }

  // Beside the page alone: half the page, whatever width a panel last had.
  await drag(page, sidebarRow(page, names.b), await at(mainPane(page), 0.95, 0.4), shows("right"))
  await expectSize(tabPane(page, streamB), "width")

  // Beside a panel: half of it, the panel keeping the other half.
  await drag(page, sidebarRow(page, names.c), await settledAt(tabPane(page, streamB), 0.95, 0.5), shows("right"))
  await expectSize(tabPane(page, streamC), "width")
  await expectSize(tabPane(page, streamB), "width")

  // A pane alone in its column brings its width along, and the one it lands beside keeps its own;
  // halving again would leave each a quarter of what B had.
  const widthOf = async (pane: Locator) => (await sizeOf(pane)).width
  await settled(tabPane(page, streamC))
  const [widthC, widthB] = [await widthOf(tabPane(page, streamC)), await widthOf(tabPane(page, streamB))]
  await drag(
    page,
    tabPane(page, streamC).locator("[data-pane-drag-handle]"),
    await settledAt(tabPane(page, streamB), 0.05, 0.5),
    shows("left")
  )
  await expectSize(tabPane(page, streamC), "width")
  await settled(tabPane(page, streamC))
  expect({ c: await widthOf(tabPane(page, streamC)), b: await widthOf(tabPane(page, streamB)) }).toEqual({
    c: widthC,
    b: widthB,
  })
  expect(panelParam(page)).toBe(`${streamA}-${streamC}-${streamB}`)

  await drag(
    page,
    tabPane(page, streamC).locator("[data-pane-drag-handle]"),
    await settledAt(tabPane(page, streamB), 0.5, 0.8),
    shows("bottom")
  )
  await expectSize(tabPane(page, streamC), "height")
  await expectSize(tabPane(page, streamB), "height")
})

test("should open, split and splice where a sidebar row or a tab is dropped, without remounting main", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await holdableGlides(page)
  const { names, streamA, streamB, streamC } = await seed(page)
  await tag(mainPane(page).getByText("said in a"), "main")
  const boxOf = async (pane: Locator) => {
    const box = (await pane.boundingBox())!
    return { x: Math.round(box.x), width: Math.round(box.width) }
  }
  const mainBefore = await boxOf(mainPane(page))
  await holdGlides(page)

  await drag(page, sidebarRow(page, names.b), await at(mainPane(page), 0.95, 0.4), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "right")
  })
  // The added pane holds its timeline until the glide lands, so mounting it never delays the glide's frames.
  await expect(tabPane(page, streamB)).toBeVisible()
  await expect(tabPane(page, streamB).getByTestId("stream-timeline")).toHaveCount(0)
  // Midway, both panes move: main part shrunk, its content as wide as its box, and the added pane opening
  // out of the divider at main's edge to its own final right edge, so neither covers the other.
  const midway = await page.evaluate((added) => {
    const main = document.querySelector("[data-testid='main-pane']")!
    const mainBox = main.getBoundingClientRect()
    const addedBox = document.querySelector(`[data-panel-tab="${added}"]`)!.getBoundingClientRect()
    const gap = addedBox.left - mainBox.right
    const beside = document.elementFromPoint(mainBox.right + 4, mainBox.top + mainBox.height / 4)
    return {
      main: Math.round(mainBox.width),
      content: Math.round(main.querySelector("[data-editor-zone='main']")!.getBoundingClientRect().width),
      abuts: gap >= 0 && gap <= 1.5,
      beside: beside?.closest("[data-panel-tab]")?.getAttribute("data-panel-tab"),
      right: Math.round(addedBox.right),
    }
  }, streamB)
  await releaseGlides(page)
  await settled(tabPane(page, streamB))
  await expect(tabPane(page, streamB).getByText("said in b")).toBeVisible()
  const mainAfter = await boxOf(mainPane(page))
  const addedAfter = await boxOf(tabPane(page, streamB))
  expect(midway.main).toBeGreaterThan(mainAfter.width)
  expect(midway.main).toBeLessThan(mainBefore.width)
  expect(midway).toEqual({
    main: midway.main,
    content: midway.main,
    abuts: true,
    beside: streamB,
    right: addedAfter.x + addedAfter.width,
  })
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({
    stream: streamB,
    panel: `${streamA}-${streamB}`,
  })
  await expect(page.getByTestId("pane-drop-indicator")).toHaveCount(0)

  await drag(page, sidebarRow(page, names.c), await settledAt(tabPane(page, streamB), 0.5, 0.8), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "bottom")
  })
  await expect(tabPane(page, streamC).getByText("said in c")).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({
    stream: streamC,
    panel: `${streamA}-${streamB}--${streamC}`,
  })

  // C's header onto B's centre: one section, which needs its tab row.
  await drag(
    page,
    tabPane(page, streamC).locator("[data-pane-drag-handle]"),
    await settledAt(tabPane(page, streamB), 0.5, 0.5),
    async () => {
      await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "centre")
    }
  )
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${streamB}.${streamC}`)

  // C's tab onto B's tab, ahead of it: C on show.
  await drag(
    page,
    tabLink(page, streamC, streamC),
    await settledAt(tabLink(page, streamC, streamB), 0.1, 0.5),
    async () => {
      await expect(tabPane(page, streamC).getByTestId("strip-drop-caret")).toBeVisible()
    }
  )
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${streamC}*.${streamB}`)
  await expect(tabPane(page, streamC).getByText("said in c")).toBeVisible()
  expect(await tagOf(mainPane(page).getByText("said in a"))).toBe("main")

  // The tab on show, past the strip's last tab: to the end. The page's conversation views follow
  // the route, and on C they would fold B's tab away, so work in A first.
  await mainPane(page).locator('[contenteditable="true"]').last().click()
  await expect.poll(() => streamIdOf(page)).toBe(streamA)
  await drag(
    page,
    tabLink(page, streamC, streamC),
    await settledAt(tabLink(page, streamC, streamB), 0.9, 0.5),
    async () => {
      await expect(tabPane(page, streamC).getByTestId("strip-drop-caret")).toBeVisible()
    }
  )
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: streamC,
      panel: `${streamA}-${streamB}.${streamC}`,
    })

  // Moving a tab rearranges in place; Back undoes the stream dropped in before it.
  await page.goBack()
  await expect
    .poll(() => ({ stream: streamIdOf(page), panel: panelParam(page) }))
    .toEqual({
      stream: streamB,
      panel: `${streamA}-${streamB}`,
    })
  expect(await tagOf(mainPane(page).getByText("said in a"))).toBe("main")
})

test("should slide a divider in and out with the pane edge it marks", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  await holdableGlides(page)
  const { names, streamB, streamC } = await seed(page)
  const alone = (await mainEdge(page)).main
  await holdGlides(page)

  await drag(page, sidebarRow(page, names.b), await at(mainPane(page), 0.95, 0.4))
  await expect(tabPane(page, streamB)).toBeVisible()
  const opening = await mainEdge(page)
  // One animation drives the glide, so the divider and the edges it marks cannot run on different clocks.
  expect(await glides(page)).toEqual(["host"])
  await releaseGlides(page)
  await settled(tabPane(page, streamB))
  const beside = (await mainEdge(page)).main
  expect(opening.main).toBeGreaterThan(beside)
  expect(opening.main).toBeLessThan(alone)
  expect(opening.dividers).toEqual([0])

  await holdGlides(page)
  await tabPane(page, streamB).getByRole("button", { name: "Close", exact: true }).click()
  await expect(tabPane(page, streamB)).toHaveCount(0)
  const closing = await mainEdge(page)
  await releaseGlides(page)
  expect(closing.main).toBeGreaterThan(beside)
  expect(closing.main).toBeLessThan(alone)
  expect(closing.dividers).toEqual([0])
  await expect.poll(() => mainEdge(page)).toEqual({ main: alone, dividers: [] })

  await drag(page, sidebarRow(page, names.b), await settledAt(mainPane(page), 0.95, 0.4))
  await drag(page, sidebarRow(page, names.c), await settledAt(tabPane(page, streamB), 0.5, 0.95))
  await settled(tabPane(page, streamC))
  const under = (await topEdge(page, streamC)).top
  await holdGlides(page)
  await tabPane(page, streamB).getByRole("button", { name: "Close", exact: true }).click()
  await expect(tabPane(page, streamB)).toHaveCount(0)
  const rising = await topEdge(page, streamC)
  await releaseGlides(page)
  expect(rising.top).toBeGreaterThan(0)
  expect(rising.top).toBeLessThan(under)
  expect(rising.dividers).toEqual([0])
})

test("should leave a stream or its tab dropped on the composer to the composer, as a link", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 })
  const { names, streamA, streamB, streamC } = await seed(page)
  const editor = mainPane(page).locator("[data-message-composer-root] [contenteditable='true']").first()

  await drag(page, sidebarRow(page, names.c), await at(editor, 0.5, 0.5))
  await expect(editor.locator("[data-type='in-app-link-chip']")).toContainText(names.c)
  expect(panelParam(page)).toBeNull()

  // A stream's tab carries its link the same way; a lone panel shows a title, not tabs, so it takes a second.
  await drag(page, sidebarRow(page, names.b), await at(mainPane(page), 0.95, 0.4))
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${streamB}`)
  await drag(page, sidebarRow(page, names.c), await settledAt(tabPane(page, streamB), 0.5, 0.5), async () => {
    await expect(page.getByTestId("pane-drop-indicator")).toHaveAttribute("data-drop", "centre")
  })
  await expect.poll(() => panelParam(page)).toBe(`${streamA}-${streamB}.${streamC}`)
  // Working in A takes the page's conversation views off C, which would fold B's tab away.
  await editor.click()
  await expect.poll(() => panelParam(page)).toBe(`${streamB}.${streamC}`)
  await drag(page, tabLink(page, streamC, streamB), await at(editor, 0.5, 0.5))
  await expect(editor.locator("[data-type='in-app-link-chip']").filter({ hasText: names.b })).toBeVisible()
  expect({ stream: streamIdOf(page), panel: panelParam(page) }).toEqual({
    stream: streamA,
    panel: `${streamB}.${streamC}`,
  })
})
