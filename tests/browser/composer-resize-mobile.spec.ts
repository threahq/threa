import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 800 }

test("mobile composer resizes from its top edge without losing the editor bottom", async ({
  page: setupPage,
  browser,
}) => {
  await loginAndCreateWorkspace(setupPage, "composer-resize")
  await createChannel(setupPage, `resize-${Date.now().toString(36)}`)
  const storageState = await setupPage.context().storageState()
  const context = await browser.newContext({ storageState, hasTouch: true, viewport: PHONE })
  const page = await context.newPage()
  await page.addInitScript(() => {
    let height = window.innerHeight
    const viewport = new EventTarget()
    Object.defineProperties(viewport, {
      height: { get: () => height },
      width: { get: () => window.innerWidth },
      offsetLeft: { value: 0 },
      offsetTop: { value: 0 },
      pageLeft: { value: 0 },
      pageTop: { value: 0 },
      scale: { value: 1 },
    })
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport })
    Object.defineProperty(window, "__setTestVisualViewportHeight", {
      value: (next: number) => {
        height = next
        viewport.dispatchEvent(new Event("resize"))
      },
    })
  })
  await page.goto(setupPage.url())

  const card = page.locator("[data-message-composer-root] [data-composer-card]").first()
  const composerShell = card.locator("xpath=../..")
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()

  const editor = page.locator("[data-message-composer-root] .tiptap").first()
  const scroller = page.getByTestId("composer-editor-scroll")
  const handle = page.getByTestId("composer-resize-handle")
  await expect(handle).toBeVisible({ timeout: 10_000 })

  await page.setViewportSize({ width: 800, height: 390 })
  await expect(handle).toBeVisible()
  await page.setViewportSize(PHONE)

  await editor.click()
  for (let i = 1; i <= 24; i++) {
    await editor.pressSequentially(`line ${i}`)
    await page.keyboard.press("Shift+Enter")
  }
  const contentBeforeResize = await editor.textContent()

  await scroller.evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 24)
  })

  const measure = () =>
    page.evaluate(() => {
      const cardEl = document.querySelector("[data-message-composer-root] [data-composer-card]") as HTMLElement
      const handleEl = document.querySelector('[data-testid="composer-resize-handle"]') as HTMLElement
      const scrollerEl = document.querySelector('[data-testid="composer-editor-scroll"]') as HTMLElement
      const cardRect = cardEl.getBoundingClientRect()
      const handleRect = handleEl.getBoundingClientRect()
      const scrollerRect = scrollerEl.getBoundingClientRect()
      return {
        cardTop: Math.round(cardRect.top),
        cardBottom: Math.round(cardRect.bottom),
        cardHeight: Math.round(cardRect.height),
        handleWidth: Math.round(handleRect.width),
        editorInset: Math.round(scrollerRect.top - cardRect.top),
        scrollBottom: Math.round(scrollerEl.scrollHeight - scrollerEl.clientHeight - scrollerEl.scrollTop),
      }
    })

  const before = await measure()
  expect(Math.abs(before.handleWidth - 64)).toBeLessThanOrEqual(1)
  expect(before.editorInset).toBeLessThanOrEqual(16)

  const cdp = await page.context().newCDPSession(page)
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: PHONE.width / 2, y: 24, id: 1 }],
  })
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: PHONE.width / 2, y: 54, id: 1 }],
  })
  await expect(page.getByText("Pull to refresh")).toBeVisible()
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect(page.getByText("Pull to refresh")).toHaveCount(0)
  await page.waitForTimeout(350)
  const touchBefore = await measure()

  const touchBox = (await handle.boundingBox())!
  const touchX = Math.round(touchBox.x + touchBox.width / 2)
  const touchY = Math.round(touchBox.y + touchBox.height / 2)
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: touchX, y: touchY, id: 1 }],
  })
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: touchX, y: touchY + 80, id: 1 }],
  })
  await expect(page.getByText(/Pull to refresh|Release to refresh|Release to reload/)).toHaveCount(0)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  const afterTouch = await measure()
  expect(afterTouch.cardHeight).toBeLessThan(touchBefore.cardHeight)
  expect(Math.abs(afterTouch.cardBottom - touchBefore.cardBottom)).toBeLessThanOrEqual(1)
  expect(Math.abs(afterTouch.scrollBottom - touchBefore.scrollBottom)).toBeLessThanOrEqual(1)

  await page.evaluate(() =>
    (
      window as typeof window & { __setTestVisualViewportHeight: (height: number) => void }
    ).__setTestVisualViewportHeight(500)
  )
  await expect.poll(async () => (await measure()).cardHeight).toBeLessThanOrEqual(250)
  const constrained = await measure()
  expect(Math.abs(constrained.scrollBottom - afterTouch.scrollBottom)).toBeLessThanOrEqual(1)

  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120)
  await page.mouse.up()

  await expect
    .poll(async () => Math.abs((await measure()).scrollBottom - constrained.scrollBottom))
    .toBeLessThanOrEqual(1)
  const after = await measure()
  expect(after.cardHeight).toBeLessThan(constrained.cardHeight)
  expect(after.cardTop).toBeGreaterThan(constrained.cardTop)
  expect(after.cardBottom).toBeCloseTo(constrained.cardBottom, 0)
  expect(await editor.textContent()).toBe(contentBeforeResize)

  // The size toggle lives in the + menu on a phone; picking a row closes it.
  await page.getByRole("button", { name: "More" }).click()
  await page.getByRole("button", { name: "Expand editor" }).click()
  await expect(page.getByTestId("composer-foot-menu")).toHaveCount(0)
  const fullscreen = await page.evaluate(() => {
    const zone = document.querySelector('[data-editor-zone="main"]')!.getBoundingClientRect()
    const card = document.querySelector("[data-message-composer-root] [data-composer-card]")!.getBoundingClientRect()
    return {
      height: Math.round(card.height),
      topGap: Math.round(card.top - zone.top),
      bottomGap: Math.round(zone.bottom - card.bottom),
    }
  })
  expect(Math.abs(fullscreen.topGap - fullscreen.bottomGap)).toBeLessThanOrEqual(1)

  await page.getByRole("button", { name: "More" }).click()
  await page.getByRole("button", { name: "Minimize editor" }).click()
  await expect.poll(async () => Math.round((await card.boundingBox())!.height)).toBeLessThan(fullscreen.height)

  const minHandle = (await handle.boundingBox())!
  await page.mouse.move(minHandle.x + minHandle.width / 2, minHandle.y + minHandle.height / 2)
  await page.mouse.down()
  await page.mouse.move(minHandle.x + minHandle.width / 2, minHandle.y + minHandle.height / 2 + 500)
  await page.mouse.up()
  const compactHeight = Math.round((await card.boundingBox())!.height)

  // Formatting swaps the foot row for the marks: the card keeps its height and
  // the editor keeps the caret (the keyboard stays up) while it is open.
  await page.getByRole("button", { name: "Formatting" }).click()
  await expect(page.getByRole("button", { name: "Bold" })).toBeVisible()
  expect(Math.round((await card.boundingBox())!.height)).toBe(compactHeight)
  expect(await page.evaluate(() => document.activeElement?.getAttribute("contenteditable"))).toBe("true")
  await page.getByRole("button", { name: "Formatting" }).click()
  await expect(page.getByRole("button", { name: "Bold" })).toHaveCount(0)

  await page.locator('[data-message-composer-root] button[aria-label^="Send"]').click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("threa:composer-drag-height"))).toBeNull()
  await expect.poll(() => composerShell.evaluate((element) => (element as HTMLElement).style.minHeight)).toBe("")
  await context.close()
})
