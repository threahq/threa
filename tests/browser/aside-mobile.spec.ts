import { test, expect, type Locator, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The aside on a phone: a sheet that peeks over the host, pulls up to the whole
 * viewport, drags down to the strip above the composer, and leaves nothing
 * behind when the OS back gesture closes it. The drag is a real pointer drag —
 * the snap detents are unit-tested, what this proves is that the handle is
 * wired to them and the surfaces actually swap.
 */

test.describe.configure({ timeout: 150_000 })

const PHONE = { width: 390, height: 780 }
const MESSAGE_COUNT = 8

async function seedMessages(page: Page, workspaceId: string, streamId: string, prefix: string): Promise<void> {
  for (let n = 1; n <= MESSAGE_COUNT; n++) {
    const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: `${prefix} msg-${String(n).padStart(3, "0")}` },
    })
    expectApiOk(response, `Send message ${n}`)
  }
}

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) throw new Error(`Could not extract IDs from URL: ${url}`)
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

const sheet = (page: Page) => page.getByTestId("aside-sheet")
const handle = (page: Page) => page.getByTestId("aside-sheet-handle")
const pane = (page: Page) => page.getByTestId("aside-pane")

function hostScroller(page: Page, streamId: string): Locator {
  return page.locator(`[data-stream-scroller="${streamId}"]`)
}

async function sheetHeight(page: Page): Promise<number> {
  const box = await sheet(page).boundingBox()
  if (!box) throw new Error("aside sheet has no box")
  return Math.round(box.height)
}

/**
 * Drag the handle by `dy` (negative = up) as a real pointer gesture. The end
 * point is kept inside the viewport — a synthetic move past the edge is not
 * delivered, which silently turns a full-length drag into no drag at all.
 */
async function dragHandle(page: Page, dy: number): Promise<void> {
  const box = await handle(page).boundingBox()
  if (!box) throw new Error("aside handle has no box")
  const handleCenterX = box.x + box.width / 2
  const handleCenterY = box.y + box.height / 2
  const endY = Math.max(2, Math.min(PHONE.height - 2, handleCenterY + dy))
  await page.mouse.move(handleCenterX, handleCenterY)
  await page.mouse.down()
  // Several steps so the drag reads as a drag, ending slowly so the release
  // settles on distance rather than a flick.
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await page.mouse.move(handleCenterX, handleCenterY + (endY - handleCenterY) * step)
  }
  await page.waitForTimeout(200)
  await page.mouse.up()
}

async function openAsideFromPalette(page: Page): Promise<void> {
  // The command palette, not the slash command: at phone width the suggestion
  // popup's rows are unreliable to hit, and the palette is the entry point a
  // phone actually offers (the sidebar's Commands button opens the same thing).
  await page.keyboard.press("ControlOrMeta+Shift+KeyK")
  const command = page.getByText("Open an aside here").first()
  await expect(command).toBeVisible({ timeout: 10000 })
  await command.click()
  // The palette's overlay covers the page while it closes, and a drag started
  // against it never reaches the sheet's handle.
  await expect(page.getByRole("dialog")).toHaveCount(0)
}

test.describe("Aside — mobile surface", () => {
  let testId: string

  test.beforeEach(async ({ page }) => {
    const result = await loginAndCreateWorkspace(page, "aside-mobile")
    testId = result.testId
  })

  test("peeks over the host, pulls up to full, closes on back, and dismisses when dragged to the floor", async ({
    page,
  }) => {
    // Channel creation drives desktop chrome (the sidebar's "+ New Channel"),
    // so the phone viewport is taken only once the fixture stream exists.
    await createChannel(page, `aside-m-${testId}`)
    const { workspaceId, streamId } = extractIds(page)
    const prefix = `[${testId}]`
    await seedMessages(page, workspaceId, streamId, prefix)
    await page.setViewportSize(PHONE)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(hostScroller(page, streamId)).toBeVisible({ timeout: 20000 })

    await openAsideFromPalette(page)

    // Peek: the sheet is well short of the viewport, and the host is still there.
    await expect(sheet(page)).toHaveAttribute("data-detent", "peek", { timeout: 15000 })
    await expect(pane(page)).toBeVisible()
    const peek = await sheetHeight(page)
    expect(peek).toBeLessThan(PHONE.height * 0.7)
    expect(peek).toBeGreaterThan(PHONE.height * 0.25)
    await expect(hostScroller(page, streamId)).toBeVisible()

    // Pull up: the sheet takes the viewport.
    await dragHandle(page, -PHONE.height * 0.5)
    await expect(sheet(page)).toHaveAttribute("data-detent", "full", { timeout: 10000 })
    expect(await sheetHeight(page)).toBeGreaterThan(PHONE.height * 0.9)

    // OS back closes the aside rather than leaving the stream.
    await page.goBack()
    await expect(sheet(page)).toHaveCount(0)
    expect(page.url()).toContain(streamId)

    // The anchor row is the way back in.
    const anchor = hostScroller(page, streamId).locator("[data-aside-id]").first()
    await expect(anchor).toBeVisible({ timeout: 10000 })
    // The whole row is the control.
    await anchor.click()
    await expect(sheet(page)).toBeVisible({ timeout: 10000 })

    // Drag to the floor: the aside is left, silently, with nothing behind it.
    await dragHandle(page, PHONE.height)
    await expect(sheet(page)).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)

    // And its anchor row still brings it back, into the surface it was last read in.
    await anchor.click()
    await expect(sheet(page)).toHaveAttribute("data-detent", "full", { timeout: 10000 })
  })
})
