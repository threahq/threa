import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel, expectApiOk } from "./helpers"

/**
 * The mobile attachment tray sits above the composer card, inside the shell
 * whose height the drag handle caps. Shrinkable, the tray absorbed the whole
 * cap deficit — the chip row collapsed under its chips and sliced them off at
 * the bottom, resizing again on every card-height change. Only a real engine
 * answers this: the deficit comes from flex distribution over measured boxes.
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 800 }

const DRAFT =
  "Can you make sure the loading indicator in the topbar had the correct z index? In this video you can see it flashing by on top of the sidebar which is wrong, it should be below the sidebar. "

test("dragging the composer down never slices the attachment chips", async ({ page }) => {
  await loginAndCreateWorkspace(page, "tray-size")
  await createChannel(page, `tray-${Date.now().toString(36)}`)

  const url = page.url()
  const workspaceId = url.match(/\/w\/([^/]+)/)?.[1]
  const streamId = url.match(/\/s\/([^/?]+)/)?.[1]
  expect(workspaceId && streamId, `ids in URL: ${url}`).toBeTruthy()

  for (let i = 1; i <= 12; i++) {
    await expectApiOk(
      await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
        data: { streamId, content: `seed ${i}` },
      }),
      `seed ${i}`
    )
  }

  await page.setViewportSize(PHONE)
  await page.reload()

  const card = page.locator("[data-message-composer-root] [data-composer-card]").first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()
  const editor = page.locator("[data-message-composer-root] .tiptap").first()
  await expect(page.getByTestId("composer-resize-handle")).toBeVisible({ timeout: 10_000 })

  await page.locator('[data-message-composer-root] input[type="file"][multiple]').setInputFiles({
    name: "VID_20260813_174107.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.alloc(2048, 7),
  })
  await expect(page.getByTestId("attachment-chip-row")).toBeVisible({ timeout: 20_000 })

  await editor.click()
  await editor.pressSequentially(DRAFT.repeat(3), { delay: 1 })

  const measure = () =>
    page.evaluate(() => {
      const row = document.querySelector('[data-testid="attachment-chip-row"]') as HTMLElement
      const chip = row.firstElementChild as HTMLElement
      return {
        rowBottom: Math.round(row.getBoundingClientRect().bottom),
        rowHeight: Math.round(row.getBoundingClientRect().height),
        chipBottom: Math.round(chip.getBoundingClientRect().bottom),
        chipHeight: Math.round(chip.getBoundingClientRect().height),
      }
    })

  const resting = await measure()
  expect(resting.rowHeight).toBe(resting.chipHeight)

  // Drag the composer's top edge down, past the point where the card hits its
  // own floor: every step must leave the one chip row at its natural height.
  const handle = page.getByTestId("composer-resize-handle")
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (const dy of [40, 80, 120, 160, 200]) {
    await page.mouse.move(x, y + dy)
    expect(await measure(), `chips intact at drag +${dy}`).toMatchObject({
      rowHeight: resting.chipHeight,
      chipHeight: resting.chipHeight,
    })
  }
  await page.mouse.up()

  const dragged = await measure()
  expect(dragged.chipBottom, "chip ends inside its row").toBeLessThanOrEqual(dragged.rowBottom)
  expect(dragged.rowHeight).toBe(resting.chipHeight)

  // A cap chosen while nothing was attached outlives that state. With the tray
  // holding its height, the card would take the whole deficit — down to 38px,
  // its action bar spilling below the viewport. The cap floors at
  // MOBILE_COMPOSER_DRAG_MIN_PX + the tray's measured height instead.
  await page.evaluate(() => localStorage.setItem("threa:composer-drag-height", "180"))
  await page.reload()
  await card.click()
  await expect(page.getByTestId("composer-resize-handle")).toBeVisible({ timeout: 10_000 })
  await page.locator('[data-message-composer-root] input[type="file"][multiple]').setInputFiles(
    [1, 2, 3, 4, 5, 6].map((n) => ({
      name: `another-really-long-attachment-name-${n}.mp4`,
      mimeType: "video/mp4",
      buffer: Buffer.alloc(1024, n),
    }))
  )
  await expect
    .poll(
      () =>
        page
          .locator("[data-message-composer-root] [data-composer-card]")
          .evaluate((el) => Math.round(el.getBoundingClientRect().height)),
      { timeout: 20_000 }
    )
    .toBeGreaterThanOrEqual(104)

  const send = await page
    .locator('[data-message-composer-root] button[aria-label^="Send"]')
    .evaluate((el) => ({ bottom: el.getBoundingClientRect().bottom, viewport: window.innerHeight }))
  expect(send.bottom, "send button stays inside the viewport").toBeLessThanOrEqual(send.viewport)
})
