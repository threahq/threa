import { test, expect, type Page, type Locator } from "@playwright/test"
import { editLastMessageViaArrowUp, expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"

const PNG_1X1 = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4,
  0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]
const IMAGE_NAME = "pasted-image-1.png"

function composerEditor(page: Page): Locator {
  return page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
}

function editForm(page: Page): Locator {
  return page.locator("[data-editor-zone='main'] [contenteditable='true']").first()
}

async function sendComposer(page: Page): Promise<void> {
  await page.getByRole("main").getByRole("button", { name: "Send", exact: true }).click()
}

function lastMessage(page: Page): Locator {
  return page.getByRole("main").locator("[data-message-id]").last()
}

async function openScratchpad(page: Page, name: string): Promise<void> {
  await loginAndCreateWorkspace(page, name)
  const workspaceId = workspaceIdFromUrl(page)
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "scratchpad" },
  })
  await expectApiOk(response, "Create scratchpad")
  const { stream } = (await response.json()) as { stream: { id: string } }
  await page.goto(`/w/${workspaceId}/s/${stream.id}`)
  await expect(composerEditor(page)).toBeVisible({ timeout: 10000 })
}

/**
 * The row first mounts under an optimistic `temp_` id and remounts under the
 * server id, which drops an edit form opened in between.
 */
async function expectLastMessageConfirmed(page: Page): Promise<void> {
  await expect(lastMessage(page)).not.toHaveAttribute("data-message-id", /^temp_/, { timeout: 10000 })
}

/** Pastes a PNG into the composer and waits for its pill to finish uploading. */
async function pasteImage(page: Page): Promise<Locator> {
  await composerEditor(page).focus()
  await composerEditor(page).evaluate((editor, bytes) => {
    const file = new File([new Uint8Array(bytes)], "screenshot.png", { type: "image/png" })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer }))
  }, PNG_1X1)
  const pill = composerEditor(page).getByRole("button", { name: IMAGE_NAME, exact: true })
  await expect(pill).toBeVisible({ timeout: 10000 })
  return pill
}

test.describe("Composer task lists and inline images", () => {
  test.beforeEach(async ({ page }) => {
    await openScratchpad(page, "composer-blocks")
  })

  test("should send and re-edit a task list when typed with the markdown shortcut", async ({ page }) => {
    await composerEditor(page).click()
    await page.keyboard.type("- [ ] milk")
    await page.keyboard.press("Shift+Enter")
    await page.keyboard.type("done")
    await expect(composerEditor(page).locator("ul[data-type='taskList'] > li")).toHaveCount(2)
    // The second item's checkbox is the composer's own control.
    await composerEditor(page).locator("ul[data-type='taskList'] > li").nth(1).locator("input[type='checkbox']").check()
    await sendComposer(page)

    const checkboxes = lastMessage(page).getByRole("checkbox")
    await expect(checkboxes).toHaveCount(2, { timeout: 10000 })
    await expect(checkboxes.nth(0)).not.toBeChecked()
    await expect(checkboxes.nth(1)).toBeChecked()
    await expect(lastMessage(page)).toContainText("milk")
    await expect(lastMessage(page)).toContainText("done")
    await expectLastMessageConfirmed(page)

    await editLastMessageViaArrowUp(page)
    await expect(editForm(page).locator("ul[data-type='taskList'] > li")).toHaveCount(2)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
  })

  test("should start a task list when the Checklist button is clicked", async ({ page }) => {
    await composerEditor(page).click()
    const checklist = page.getByRole("main").getByRole("button", { name: "Checklist", exact: true })
    if (!(await checklist.isVisible())) {
      await page.getByRole("main").getByRole("button", { name: "Formatting", exact: true }).click()
    }
    await checklist.click()
    await page.keyboard.type("a")
    await expect(composerEditor(page).locator("ul[data-type='taskList']")).toContainText("a")

    await composerEditor(page).focus()
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.press("Backspace")
    await expect(composerEditor(page).locator("ul[data-type='taskList']")).toHaveCount(0)
  })

  test("should show an image inline and back as a chip when toggled from its pill", async ({ page }) => {
    const pill = await pasteImage(page)
    await pill.click()
    await page.getByRole("button", { name: "Show as image", exact: true }).click()
    await expect(composerEditor(page).locator(`img[alt='${IMAGE_NAME}']`)).toBeVisible({ timeout: 10000 })
    await sendComposer(page)

    const body = lastMessage(page).locator(".markdown-content")
    await expect(body.locator(`img[alt='${IMAGE_NAME}']`)).toBeVisible({ timeout: 10000 })
    // The inline image and the attachment strip tile are both buttons named after the file:
    // the one in the body is the inline image, and the message holds no second one.
    await expect(body.getByRole("button", { name: IMAGE_NAME, exact: true })).toHaveCount(1)
    await expect(lastMessage(page).getByRole("button", { name: IMAGE_NAME, exact: true })).toHaveCount(1)
    await expectLastMessageConfirmed(page)

    await editLastMessageViaArrowUp(page)
    const editImage = editForm(page).locator(`img[alt='${IMAGE_NAME}']`)
    await expect(editImage).toBeVisible({ timeout: 10000 })
    await editImage.click()
    await page.getByRole("button", { name: "Show as chip", exact: true }).click()
    await expect(editImage).toHaveCount(0)
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)

    await expect(body.locator("img")).toHaveCount(0, { timeout: 10000 })
    await expect(body.getByRole("button", { name: IMAGE_NAME })).toBeVisible()
    await expect(lastMessage(page).locator(`img[alt='${IMAGE_NAME}']`)).toBeVisible()
  })
})

test.describe("Composer inline images on mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test.beforeEach(async ({ page }) => {
    await openScratchpad(page, "composer-blocks-mobile")
  })

  test("should show an image inline when toggled from the touch action bar", async ({ page }) => {
    const pill = await pasteImage(page)
    await pill.tap()
    const showAsImage = page.getByRole("button", { name: "Show as image", exact: true })
    await showAsImage.tap()
    await expect(composerEditor(page).locator(`img[alt='${IMAGE_NAME}']`)).toBeVisible({ timeout: 10000 })
    // The action bar closes once the pill becomes an image.
    await expect(showAsImage).toHaveCount(0)
    await sendComposer(page)

    const body = lastMessage(page).locator(".markdown-content")
    await expect(body.locator(`img[alt='${IMAGE_NAME}']`)).toBeVisible({ timeout: 10000 })
  })
})
