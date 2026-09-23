import { test, expect } from "@playwright/test"
import { createChannel, expectApiOk, loginAndCreateWorkspace } from "./helpers"

test("keeps the sent-message menu open beside its reminder choices", async ({ page }) => {
  test.setTimeout(60000)
  const { testId } = await loginAndCreateWorkspace(page, "reminder-menu")
  await createChannel(page, `reminder-${testId}`, { switchToAll: false })
  const [, workspaceId, streamId] = page.url().match(/\/w\/([^/]+)\/s\/([^/?]+)/) ?? []
  if (!workspaceId || !streamId) throw new Error(`Unexpected channel URL ${page.url()}`)
  const message = "Please review the notes before Thursday's planning call."
  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: {
      streamId,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: message }] }] },
      contentMarkdown: message,
    },
  })
  await expectApiOk(response, "Create message")
  const row = page.getByRole("main").locator("[data-message-id]").filter({ hasText: message }).first()
  await expect(row).toBeVisible()
  await row.hover()
  const trigger = row.getByRole("button", { name: "Message actions" })
  await trigger.click()
  const rootMenu = page.getByRole("menu", { name: "Message actions" })
  const reminderTrigger = rootMenu.getByRole("menuitem", { name: "Set reminder…" })
  await reminderTrigger.hover()
  const preset = page.getByRole("menuitem", { name: "In 15 minutes" })
  await expect(rootMenu).toBeVisible()
  await expect(reminderTrigger).toHaveAttribute("data-state", "open")
  await expect(preset).toBeVisible()
  const anchor = await reminderTrigger.boundingBox()
  const choice = await preset.boundingBox()
  expect(anchor && choice).toBeTruthy()
  expect(Math.abs(choice!.y - anchor!.y)).toBeLessThan(190)
  const horizontalGap = Math.min(
    Math.abs(choice!.x + choice!.width - anchor!.x),
    Math.abs(anchor!.x + anchor!.width - choice!.x)
  )
  expect(horizontalGap).toBeLessThan(24)
  await page.keyboard.press("Escape")
  await expect(rootMenu).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await rootMenu.getByRole("menuitem", { name: "Set reminder…" }).hover()
  await page.getByRole("menuitem", { name: "Custom duration…" }).click()
  const durationDialog = page.getByRole("dialog", { name: "Custom reminder duration" })
  await expect(durationDialog).toBeVisible()
  await expect(rootMenu).not.toBeVisible()
  await durationDialog.getByRole("spinbutton", { name: "Custom duration" }).fill("20")
  await durationDialog.getByRole("button", { name: "Set reminder" }).click()
  await expect(durationDialog).not.toBeVisible()
  await expect(trigger).toBeFocused()

  await trigger.click()
  await rootMenu.getByRole("menuitem", { name: "Set reminder…" }).hover()
  await page.getByRole("menuitem", { name: "Pick a time…" }).click()
  const timeDialog = page.getByRole("dialog", { name: "Pick a reminder time" })
  await expect(timeDialog.getByLabel("Date and time")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(timeDialog).not.toBeVisible()
  await expect(trigger).toBeFocused()

  await trigger.click()
  await rootMenu.getByRole("menuitem", { name: "Set reminder…" }).hover()
  await page.getByRole("menuitem", { name: "In 15 minutes" }).click()
  await expect(rootMenu).not.toBeVisible()
  await expect(trigger).toBeFocused()
})
