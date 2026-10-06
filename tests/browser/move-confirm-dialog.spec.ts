import { test, expect, type Page } from "@playwright/test"
import { createChannel, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"
import { seedStream } from "./perf-fixtures"

test.setTimeout(180_000)

async function dragLastRowOntoFirst(page: Page, streamId: string, testId: string) {
  await page.evaluate((id) => {
    document.dispatchEvent(
      new CustomEvent("threa:start-batch-select", { detail: { streamId: id, intent: "moveToThread" } })
    )
  }, streamId)
  const timeline = page.getByTestId("stream-timeline")
  const rows = timeline.getByText(new RegExp(`^m-${testId} msg-000\\d$`))
  const to = await rows.first().boundingBox()
  const from = await rows.last().boundingBox()
  await page.mouse.move(from!.x + 10, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(from!.x + 10, from!.y - 20, { steps: 4 })
  await page.mouse.move(to!.x + 10, to!.y + to!.height / 2, { steps: 8 })
  await page.mouse.up()
}

test("drag-to-move confirm dialog opens, cancels, and opens again", async ({ page }) => {
  const { testId } = await loginAndCreateWorkspace(page, "mv")
  const workspaceId = workspaceIdFromUrl(page)
  await createChannel(page, `mv-${testId}`)
  const streamId = page.url().match(/\/s\/([^/?]+)/)![1]!
  await seedStream(page, workspaceId, streamId, 3, `m-${testId}`)
  await page.reload()
  await expect(page.getByTestId("stream-timeline").getByText(`m-${testId} msg-0003`)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("alertdialog")).toHaveCount(0)

  for (let round = 0; round < 2; round++) {
    await dragLastRowOntoFirst(page, streamId, testId)
    const dialog = page.getByRole("alertdialog", { name: "Move messages?" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Move" })).toBeEnabled()
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden()
  }
})
