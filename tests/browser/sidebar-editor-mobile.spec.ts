import { test, expect, type Page, type CDPSession, type Browser } from "@playwright/test"
import { SIDEBAR_CONFIG_VERSION, type SidebarConfig } from "../../packages/types/src/sidebar"
import { loginAndCreateWorkspace, openPhoneSidebar, expectApiOk, createChannel } from "./helpers"

test.describe.configure({ timeout: 90_000 })

async function touch(cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] })
}

async function readSidebarConfig(page: Page, workspaceId: string): Promise<{ sidebarConfig: SidebarConfig }> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/sidebar-config`)
  await expectApiOk(response, "Read sidebar config")
  return response.json()
}

async function openEditor(setupPage: Page, browser: Browser, sectionCount = 14, quickLinks = true, height = 780) {
  const { name } = await loginAndCreateWorkspace(setupPage, "sidebar-touch")
  await createChannel(setupPage, "touch-fixture")
  const workspaceId = new URL(setupPage.url()).pathname.split("/")[2]
  await expectApiOk(
    await setupPage.request.patch(`/api/workspaces/${workspaceId}/sidebar-config`, {
      data: {
        version: SIDEBAR_CONFIG_VERSION,
        basePreset: "all",
        sections: [
          ...Array.from({ length: sectionCount }, (_, i) => ({
            id: `custom:touch-${i}`,
            spec: { kind: "custom", sectionId: `touch-${i}`, name: `Touch section ${i}`, streamIds: [] },
          })),
          ...(quickLinks ? [{ id: "quicklinks", spec: { kind: "quicklinks" } }] : []),
        ],
      },
    }),
    "Seed sidebar sections"
  )
  const context = await browser.newContext({
    storageState: await setupPage.context().storageState(),
    hasTouch: true,
    recordVideo: { dir: test.info().outputPath("videos"), size: { width: 390, height } },
    viewport: { width: 390, height },
  })
  const page = await context.newPage()
  await page.goto(setupPage.url())
  await openPhoneSidebar(page)
  await page.getByRole("button", { name }).click({ timeout: 10_000 })
  await page.getByText("Customize sidebar", { exact: true }).click({ timeout: 10_000 })
  const dialog = page.getByRole("dialog", { name: "Customize sidebar" })
  await expect(dialog).toBeVisible()
  await page.waitForTimeout(600)
  const body = dialog.locator("div.overflow-y-auto")
  return { context, page, dialog, body, workspaceId, cdp: await context.newCDPSession(page) }
}

test("should keep drawer and section rows stationary while a touch preview follows the finger", async ({
  page: setupPage,
  browser,
}) => {
  const { context, page, dialog, body, cdp } = await openEditor(setupPage, browser)
  try {
    const handle = dialog.getByRole("button", { name: "Reorder Touch section 1", exact: true })
    const sibling = dialog.getByRole("button", { name: "Reorder Touch section 2", exact: true })
    const start = (await handle.boundingBox())!
    const drawerTop = (await dialog.boundingBox())!.y
    const siblingTop = (await sibling.boundingBox())!.y
    const scrollTop = await body.evaluate((el) => el.scrollTop)
    const x = start.x + start.width / 2
    const y = start.y + start.height / 2
    await touch(cdp, "touchStart", x, y)
    await touch(cdp, "touchMove", x, y + 12)
    await touch(cdp, "touchMove", x, y + 65)
    await page.waitForTimeout(150)
    expect((await dialog.boundingBox())!.y).toBeCloseTo(drawerTop, 0)
    expect((await handle.boundingBox())!.y).toBeCloseTo(start.y, 0)
    expect((await sibling.boundingBox())!.y).toBeCloseTo(siblingTop, 0)
    expect(await body.evaluate((el) => el.scrollTop)).toBe(scrollTop)
    const preview = page.getByTestId("sidebar-drag-preview")
    await expect(preview).toBeVisible()
    const previewTop = (await preview.boundingBox())!.y
    await touch(cdp, "touchMove", x, y + 90)
    await expect.poll(async () => (await preview.boundingBox())!.y - previewTop).toBeCloseTo(25, 0)
    await page.screenshot({ path: test.info().outputPath("mobile-drag-preview.png") })
    await touch(cdp, "touchEnd")
    await expect(preview).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test("should scroll only the editor at drag edges and stop in the center", async ({ page: setupPage, browser }) => {
  const { context, page, dialog, body, cdp, workspaceId } = await openEditor(setupPage, browser)
  try {
    const configBefore = await readSidebarConfig(page, workspaceId)
    const bounds = (await body.boundingBox())!
    const handle = (await dialog.getByRole("button", { name: "Reorder Touch section 1", exact: true }).boundingBox())!
    const x = handle.x + handle.width / 2
    const drawerTop = (await dialog.boundingBox())!.y
    await touch(cdp, "touchStart", x, handle.y + handle.height / 2)
    await touch(cdp, "touchMove", x, handle.y + handle.height / 2 + 12)
    await touch(cdp, "touchMove", x, bounds.y + bounds.height - 10)
    const preview = page.getByTestId("sidebar-drag-preview")
    await expect(preview).toBeVisible()
    expect((await preview.boundingBox())!.y).toBeGreaterThan(bounds.y + bounds.height - 60)
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(80)
    await touch(cdp, "touchMove", x, bounds.y + bounds.height / 2)
    await page.waitForTimeout(100)
    const stopped = await body.evaluate((el) => el.scrollTop)
    await page.waitForTimeout(250)
    expect(await body.evaluate((el) => el.scrollTop)).toBe(stopped)
    await touch(cdp, "touchMove", x, bounds.y + 10)
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeLessThan(stopped - 30)
    expect((await dialog.boundingBox())!.y).toBeCloseTo(drawerTop, 0)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
    const cancelledAt = await body.evaluate((element) => element.scrollTop)
    await page.waitForTimeout(250)
    expect(await body.evaluate((element) => element.scrollTop)).toBe(cancelledAt)
    expect(await readSidebarConfig(page, workspaceId)).toEqual(configBefore)
    await expect(page.getByTestId("sidebar-drag-preview")).toHaveCount(0)
    const beforeSwipe = await body.evaluate((el) => el.scrollTop)
    await touch(cdp, "touchStart", bounds.x + bounds.width - 6, bounds.y + bounds.height - 40)
    for (let distance = 20; distance <= 160; distance += 20) {
      await touch(cdp, "touchMove", bounds.x + bounds.width - 6, bounds.y + bounds.height - 40 - distance)
      await page.waitForTimeout(20)
    }
    await touch(cdp, "touchEnd")
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(beforeSwipe + 30)
    await expect
      .poll(async () => {
        const scrollTop = await body.evaluate((element) => element.scrollTop)
        await page.waitForTimeout(200)
        return (await body.evaluate((element) => element.scrollTop)) === scrollTop
      })
      .toBe(true)
    await page.waitForTimeout(150)
    const beforeCollapse = (await dialog.boundingBox())!.y
    let heading = (await dialog.getByRole("heading", { name: "Customize sidebar" }).boundingBox())!
    if (beforeCollapse < 100) {
      await touch(cdp, "touchStart", 195, heading.y + 8)
      for (const distance of [40, 100, 200]) {
        await touch(cdp, "touchMove", 195, heading.y + 8 + distance)
        await page.waitForTimeout(80)
      }
      await touch(cdp, "touchEnd")
      await expect.poll(async () => (await dialog.boundingBox())!.y).toBeGreaterThan(beforeCollapse + 100)
      await page.waitForTimeout(500)
    }
    heading = (await dialog.getByRole("heading", { name: "Customize sidebar" }).boundingBox())!
    await touch(cdp, "touchStart", 195, heading.y + 8)
    for (const distance of [60, 150, 280]) {
      await touch(cdp, "touchMove", 195, heading.y + 8 + distance)
    }
    await touch(cdp, "touchEnd")
    await expect(dialog).not.toBeVisible()
  } finally {
    await context.close()
  }
})

test("should isolate nested quick-link dragging and clean up a cancelled touch", async ({
  page: setupPage,
  browser,
}) => {
  const { context, page, dialog, body, cdp, workspaceId } = await openEditor(setupPage, browser)
  try {
    const configBefore = await readSidebarConfig(page, workspaceId)
    await dialog.getByRole("button", { name: "Reorder Drafts", exact: true }).scrollIntoViewIfNeeded()
    await body.evaluate((element) => {
      const handle = element.querySelector('[aria-label="Reorder Drafts"]')!
      element.scrollTop +=
        handle.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 2
    })
    const handle = (await dialog.getByRole("button", { name: "Reorder Drafts", exact: true }).boundingBox())!
    const sibling = dialog.getByRole("button", { name: "Reorder Saved", exact: true })
    const siblingTop = (await sibling.boundingBox())!.y
    const drawerTop = (await dialog.boundingBox())!.y
    const scrollTop = await body.evaluate((el) => el.scrollTop)
    await touch(cdp, "touchStart", handle.x + 10, handle.y + 10)
    await touch(cdp, "touchMove", handle.x + 10, handle.y + 22)
    await touch(cdp, "touchMove", handle.x + 10, handle.y + 50)
    await expect(page.getByTestId("sidebar-drag-preview")).toHaveText("Drafts")
    expect((await sibling.boundingBox())!.y).toBeCloseTo(siblingTop, 0)
    expect((await dialog.boundingBox())!.y).toBeCloseTo(drawerTop, 0)
    expect(await body.evaluate((el) => el.scrollTop)).toBe(scrollTop)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
    await expect(page.getByTestId("sidebar-drag-preview")).toHaveCount(0)
    await expect(dialog.getByRole("button", { name: "Reorder Drafts", exact: true })).toBeVisible()
    expect(await readSidebarConfig(page, workspaceId)).toEqual(configBefore)
    const source = (await dialog.getByRole("button", { name: "Reorder Drafts", exact: true }).boundingBox())!
    const destination = (await sibling.locator("..").boundingBox())!
    await touch(cdp, "touchStart", source.x + 10, source.y + 10)
    await touch(cdp, "touchMove", source.x + 10, source.y + 22)
    await touch(cdp, "touchMove", destination.x + 10, destination.y + destination.height - 3)
    await expect(dialog.getByTestId("sidebar-insertion-marker")).toHaveAttribute("data-index", "1")
    await touch(cdp, "touchEnd")
    const links = [...configBefore.sidebarConfig.quickLinks]
    links.splice(1, 0, links.splice(0, 1)[0]!)
    await expect
      .poll(() => readSidebarConfig(page, workspaceId))
      .toEqual({
        ...configBefore,
        sidebarConfig: { ...configBefore.sidebarConfig, quickLinks: links },
      })
  } finally {
    await context.close()
  }
})

const insertionCases = [
  { destination: "first", count: 3, rowNumber: 0, index: 0, edge: "before" },
  { destination: "middle", count: 3, rowNumber: 1, index: 1, edge: "before" },
  { destination: "last", count: 3, rowNumber: 2, index: 3, edge: "after" },
  { destination: "empty", count: 0, rowNumber: null, index: 0, edge: "before" },
] as const

for (const { destination, count, rowNumber, index, edge } of insertionCases) {
  test(`should show and persist the ${destination} tray insertion position on touch`, async ({
    page: setupPage,
    browser,
  }) => {
    const { context, page, dialog, cdp, workspaceId } = await openEditor(setupPage, browser, count, false)
    try {
      const chip = dialog.getByRole("button", { name: "Add Everything Else", exact: true })
      const source = (await chip.boundingBox())!
      const targetElement =
        rowNumber === null
          ? dialog.getByText("Empty sidebar.", { exact: false })
          : dialog.getByRole("button", { name: `Reorder Touch section ${rowNumber}`, exact: true }).locator("../..")
      const target = (await targetElement.boundingBox())!
      const borderTop = await targetElement.evaluate((element) => element.clientTop)
      const x = source.x + source.width / 2
      const y = source.y + source.height / 2
      await touch(cdp, "touchStart", x, y)
      await touch(cdp, "touchMove", x, y - 12)
      await touch(cdp, "touchMove", target.x + target.width / 2, target.y + (edge === "after" ? target.height - 3 : 3))
      const marker = dialog.getByTestId("sidebar-insertion-marker")
      await expect(marker).toBeVisible()
      await expect(marker).toHaveAttribute("data-index", String(index))
      const bounds = (await marker.boundingBox())!
      expect(bounds.y + bounds.height / 2).toBeCloseTo(
        edge === "after" ? target.y + target.height + 2 : target.y + borderTop - 2,
        0
      )
      if (destination === "middle") {
        const previous = (await dialog
          .getByRole("button", { name: "Reorder Touch section 0", exact: true })
          .locator("../..")
          .boundingBox())!
        expect(bounds.y + bounds.height / 2).toBeCloseTo((previous.y + previous.height + target.y) / 2, 0)
        const trayLabel = dialog.getByText("Available to add:", { exact: true })
        await expect(marker).toHaveCSS("background-color", await trayLabel.evaluate((el) => getComputedStyle(el).color))
        await page.screenshot({ path: test.info().outputPath("everything-else-insertion-light.png") })
        await page.evaluate(() => document.documentElement.classList.add("dark"))
        await expect(marker).toHaveCSS("background-color", await trayLabel.evaluate((el) => getComputedStyle(el).color))
        await page.screenshot({ path: test.info().outputPath("everything-else-insertion-dark.png") })
      }
      await touch(cdp, "touchEnd")
      await expect(marker).toHaveCount(0)
      await expect
        .poll(async () => {
          return (await readSidebarConfig(page, workspaceId)).sidebarConfig.sections.map((section) => section.id)
        })
        .toEqual([
          ...Array.from({ length: index }, (_, i) => `custom:touch-${i}`),
          "other",
          ...Array.from({ length: count - index }, (_, i) => `custom:touch-${i + index}`),
        ])
    } finally {
      await context.close()
    }
  })
}

for (const ending of ["outside", "cancel"] as const) {
  test(`should leave configuration unchanged after a tray drag ends ${ending}`, async ({
    page: setupPage,
    browser,
  }) => {
    const { context, page, dialog, cdp, workspaceId } = await openEditor(setupPage, browser, 3, false)
    try {
      const before = await readSidebarConfig(page, workspaceId)
      const chip = (await dialog.getByRole("button", { name: "Add Everything Else", exact: true }).boundingBox())!
      const row = (await dialog.getByRole("button", { name: "Reorder Touch section 1", exact: true }).boundingBox())!
      await touch(cdp, "touchStart", chip.x + 10, chip.y + 10)
      await touch(cdp, "touchMove", chip.x + 10, chip.y - 5)
      await touch(cdp, "touchMove", row.x + 10, row.y + 4)
      await expect(dialog.getByTestId("sidebar-insertion-marker")).toBeVisible()
      if (ending === "outside") {
        const heading = (await dialog.getByRole("heading", { name: "Customize sidebar" }).boundingBox())!
        await touch(cdp, "touchMove", heading.x + 10, heading.y + 10)
        await expect(dialog.getByTestId("sidebar-insertion-marker")).toHaveCount(0)
        await touch(cdp, "touchEnd")
      } else {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
      }
      await expect(page.getByTestId("sidebar-drag-preview")).toHaveCount(0)
      await expect(dialog.getByTestId("sidebar-insertion-marker")).toHaveCount(0)
      expect(await readSidebarConfig(page, workspaceId)).toEqual(before)
    } finally {
      await context.close()
    }
  })
}

test("should persist downward and upward touch reordering at the shown gap", async ({ page: setupPage, browser }) => {
  const { context, page, dialog, cdp, workspaceId } = await openEditor(setupPage, browser, 3, false)
  try {
    for (const [rowNumber, edge, order] of [
      [2, "after", [1, 2, 0]],
      [1, "before", [0, 1, 2]],
    ] as const) {
      const handle = (await dialog.getByRole("button", { name: "Reorder Touch section 0", exact: true }).boundingBox())!
      const target = (await dialog
        .getByRole("button", { name: `Reorder Touch section ${rowNumber}`, exact: true })
        .locator("../..")
        .boundingBox())!
      await touch(cdp, "touchStart", handle.x + 10, handle.y + 10)
      await touch(cdp, "touchMove", handle.x + 10, handle.y + 22)
      await touch(cdp, "touchMove", target.x + 15, target.y + (edge === "before" ? 3 : target.height - 3))
      await expect(dialog.getByTestId("sidebar-insertion-marker")).toHaveAttribute("data-edge", edge)
      await touch(cdp, "touchEnd")
      await expect
        .poll(async () =>
          (await readSidebarConfig(page, workspaceId)).sidebarConfig.sections.map(
            (section: { id: string }) => section.id
          )
        )
        .toEqual(order.map((id) => `custom:touch-${id}`))
    }
  } finally {
    await context.close()
  }
})

test("should update the insertion gap when crossing the same final row midpoint", async ({
  page: setupPage,
  browser,
}) => {
  const { context, page, dialog, cdp } = await openEditor(setupPage, browser, 3, false)
  try {
    const chip = (await dialog.getByRole("button", { name: "Add Everything Else", exact: true }).boundingBox())!
    const row = (await dialog
      .getByRole("button", { name: "Reorder Touch section 2", exact: true })
      .locator("../..")
      .boundingBox())!
    await touch(cdp, "touchStart", chip.x + 10, chip.y + 10)
    await touch(cdp, "touchMove", chip.x + 10, chip.y - 5)
    await touch(cdp, "touchMove", row.x + 20, row.y + 3)
    const marker = dialog.getByTestId("sidebar-insertion-marker")
    await expect(marker).toHaveAttribute("data-index", "2")
    await expect(marker).toHaveAttribute("data-edge", "before")
    expect((await marker.boundingBox())!.y).toBeCloseTo(row.y - 3, 0)
    await touch(cdp, "touchMove", row.x + 20, row.y + row.height - 3)
    await expect(marker).toHaveAttribute("data-index", "3")
    await expect(marker).toHaveAttribute("data-edge", "after")
    expect((await marker.boundingBox())!.y).toBeCloseTo(row.y + row.height + 1, 0)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] })
  } finally {
    await context.close()
  }
})

test("should preserve section and nested keyboard reordering on desktop", async ({ page: setupPage, browser }) => {
  const { context, page, dialog, workspaceId } = await openEditor(setupPage, browser, 2, true)
  try {
    await page.setViewportSize({ width: 1000, height: 900 })
    await expect(dialog).toBeVisible()
    const section = dialog.getByRole("button", { name: "Reorder Touch section 0", exact: true })
    await section.focus()
    await page.keyboard.press("Space")
    await page.keyboard.press("ArrowDown")
    await expect(dialog.getByTestId("sidebar-insertion-marker")).toHaveAttribute("data-index", "1")
    await page.keyboard.press("Space")
    await expect
      .poll(async () =>
        (await readSidebarConfig(page, workspaceId)).sidebarConfig.sections.map((row: { id: string }) => row.id)
      )
      .toEqual(["custom:touch-1", "custom:touch-0", "quicklinks"])
    const before = (await readSidebarConfig(page, workspaceId)).sidebarConfig.quickLinks.map(
      (link: { key: string }) => link.key
    )
    const draft = dialog.getByRole("button", { name: "Reorder Drafts", exact: true })
    await draft.focus()
    await page.keyboard.press("Space")
    await page.keyboard.press("ArrowDown")
    await expect(dialog.getByTestId("sidebar-insertion-marker")).toHaveAttribute(
      "data-index",
      String(before.indexOf("drafts") + 1)
    )
    await page.keyboard.press("Space")
    const expected = [...before]
    const index = expected.indexOf("drafts")
    expected.splice(index + 1, 0, expected.splice(index, 1)[0])
    await expect
      .poll(async () =>
        (await readSidebarConfig(page, workspaceId)).sidebarConfig.quickLinks.map((link: { key: string }) => link.key)
      )
      .toEqual(expected)
  } finally {
    await context.close()
  }
})

for (const { count, key } of [
  { count: 3, key: "Space" },
  { count: 0, key: "Enter" },
]) {
  test(`should show the saved keyboard tray position with ${count} sections using ${key}`, async ({
    page: setupPage,
    browser,
  }) => {
    const { context, page, dialog, workspaceId } = await openEditor(setupPage, browser, count, false)
    try {
      const chip = dialog.getByRole("button", { name: "Add Everything Else", exact: true })
      await chip.focus()
      await page.keyboard.press(key)
      const marker = dialog.getByTestId("sidebar-insertion-marker")
      const index = Math.max(0, count - 1)
      await expect(marker).toHaveAttribute("data-index", String(index))
      await expect(marker).toHaveAttribute("data-edge", "before")
      const targetElement =
        count === 0
          ? dialog.getByText("Empty sidebar.", { exact: false })
          : dialog.getByRole("button", { name: `Reorder Touch section ${index}`, exact: true }).locator("../..")
      const target = (await targetElement.boundingBox())!
      const borderTop = await targetElement.evaluate((element) => element.clientTop)
      expect((await marker.boundingBox())!.y).toBeCloseTo(target.y + borderTop - 3, 0)
      await page.keyboard.press(key)
      await expect(marker).toHaveCount(0)
      const expected = Array.from({ length: count }, (_, i) => `custom:touch-${i}`)
      expected.splice(index, 0, "other")
      await expect
        .poll(async () => (await readSidebarConfig(page, workspaceId)).sidebarConfig.sections.map((row) => row.id))
        .toEqual(expected)
    } finally {
      await context.close()
    }
  })
}

test("should target the full Quick Links section when adding from the tray", async ({ page: setupPage, browser }) => {
  const { context, page, dialog, cdp, workspaceId } = await openEditor(setupPage, browser, 0, true, 1100)
  try {
    const chip = dialog.getByRole("button", { name: "Add Everything Else", exact: true })
    await chip.scrollIntoViewIfNeeded()
    const source = (await chip.boundingBox())!
    const sectionElement = dialog.getByRole("button", { name: "Reorder Quick Links", exact: true }).locator("../..")
    await touch(cdp, "touchStart", source.x + 10, source.y + 10)
    await touch(cdp, "touchMove", source.x + 10, source.y - 5)
    const section = (await sectionElement.boundingBox())!
    const firstPoint = { x: section.x + section.width / 2, y: section.y + section.height / 4 }
    await touch(cdp, "touchMove", firstPoint.x, firstPoint.y)
    const marker = dialog.getByTestId("sidebar-insertion-marker")
    await expect(marker).toHaveAttribute("data-index", "0")
    const currentSection = (await sectionElement.boundingBox())!
    const lastPoint = {
      x: currentSection.x + currentSection.width / 2,
      y: currentSection.y + currentSection.height * 0.75,
    }
    await touch(cdp, "touchMove", lastPoint.x, lastPoint.y)
    await expect(marker).toHaveAttribute("data-index", "1")
    const landedSection = (await sectionElement.boundingBox())!
    expect((await marker.boundingBox())!.y).toBeCloseTo(landedSection.y + landedSection.height + 1, 0)
    await touch(cdp, "touchEnd")
    await expect
      .poll(async () =>
        (await readSidebarConfig(page, workspaceId)).sidebarConfig.sections.map((row: { id: string }) => row.id)
      )
      .toEqual(["quicklinks", "other"])
  } finally {
    await context.close()
  }
})
