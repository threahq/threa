import { test, expect, type Locator, type Page } from "@playwright/test"
import { createDocViaApi, devLogin, expectApiOk, loginAndCreateWorkspace, pane, workspaceIdFromUrl } from "./helpers"

test.describe.configure({ timeout: 150_000 })

async function openSettings(page: Page, docId: string, tap = false) {
  const actions = pane(page, docId).getByRole("button", { name: "Stream actions" }).first()
  if (tap) await actions.tap()
  else await actions.click()
  const settings = page.getByRole(tap ? "button" : "menuitem", { name: "Settings", exact: true })
  if (tap) await settings.tap()
  else await settings.click()
  return page.getByRole("dialog")
}

async function makeDocPublic(page: Page, docId: string, dialog: Locator, tap = false) {
  const publicOption = dialog.getByRole("button", { name: /^Public/ })
  if (tap) await publicOption.tap()
  else await publicOption.click()
  const confirmation = page.getByRole(tap ? "dialog" : "alertdialog", { name: "Change visibility?" })
  await expect(confirmation.getByText(/Making this doc public/)).toBeVisible()
  const confirm = page.getByRole("button", { name: "Confirm", exact: true })
  const saved = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === "PATCH" && url.pathname.endsWith(`/streams/${docId}`)
  })
  if (tap) await confirm.tap()
  else await confirm.click()
  await expectApiOk(await saved, "Make standalone doc public")
}

test("should create, join, edit and reopen a standalone doc", async ({ browser }) => {
  const ownerContext = await browser.newContext()
  const owner = await ownerContext.newPage()
  const { testId } = await loginAndCreateWorkspace(owner, "top-doc")
  const workspaceId = workspaceIdFromUrl(owner)
  const readerContext = await browser.newContext()
  const reader = await readerContext.newPage()
  const readerEmail = `top-doc-reader-${testId}@example.com`

  try {
    await owner.goto(`/w/${workspaceId}/docs`)
    const created = owner.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/streams")
    )
    await owner.getByRole("button", { name: "New doc", exact: true }).click()
    const createResponse = await created
    await expectApiOk(createResponse, "Create standalone doc from the Docs page")
    const docId = ((await createResponse.json()) as { stream: { id: string } }).stream.id

    const ownerEditor = pane(owner, docId).locator(".ProseMirror")
    await expect(ownerEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    await ownerEditor.click()
    await owner.keyboard.type("Visible standalone note")
    await expect(ownerEditor).toContainText("Visible standalone note")
    const settings = await openSettings(owner, docId)
    await expect(settings.getByRole("button", { name: "General" })).toBeVisible()
    await expect(settings.getByRole("button", { name: /^Members People/ })).toBeVisible()
    await expect(settings.getByRole("button", { name: /^Private/ })).toHaveAttribute("aria-pressed", "true")
    await makeDocPublic(owner, docId, settings)

    const readerUser = await devLogin(reader, readerEmail, `Reader ${testId}`)
    await expectApiOk(
      await reader.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member", name: readerUser.name },
      }),
      "Join workspace as a reader"
    )
    await reader.goto(`/w/${workspaceId}/s/${docId}`)
    const readerEditor = pane(reader, docId).locator(".ProseMirror")
    await expect(readerEditor).toHaveAttribute("contenteditable", "false", { timeout: 15000 })
    await expect(readerEditor).toContainText("Visible standalone note", { timeout: 15000 })
    await expect(reader.getByRole("button", { name: "Join Doc", exact: true })).toBeVisible()
    await expect(settings.getByRole("button", { name: /^Public/ })).toHaveAttribute("aria-pressed", "true")
    await expect(settings.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0)

    const joined = reader.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === "POST" && url.pathname.endsWith(`/streams/${docId}/join`)
    })
    await reader.getByRole("button", { name: "Join Doc", exact: true }).click()
    await expectApiOk(await joined, "Join standalone doc")
    await expect(readerEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    await readerEditor.click()
    await reader.keyboard.press("ControlOrMeta+End")
    await reader.keyboard.type(`Joined ${testId}`)
    await expect(readerEditor).toContainText(`Joined ${testId}`)
    await expect(ownerEditor).toContainText(`Joined ${testId}`, { timeout: 15000 })

    await reader.reload()
    await expect(readerEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    await expect(readerEditor).toContainText(`Joined ${testId}`, { timeout: 15000 })
  } finally {
    await ownerContext.close()
    await readerContext.close()
  }
})

test.describe("standalone docs on touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test("should let a phone reader join, edit and manage a standalone doc", async ({ browser, page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "top-doc-phone")
    const workspaceId = workspaceIdFromUrl(page)
    const docId = await createDocViaApi(page, workspaceId)
    await page.goto(`/w/${workspaceId}/s/${docId}`)
    const ownerEditor = pane(page, docId).locator(".ProseMirror")
    await expect(ownerEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    const ownerSettings = await openSettings(page, docId, true)
    await makeDocPublic(page, docId, ownerSettings, true)
    const ownerSettingsSelect = ownerSettings.getByRole("combobox").filter({ hasText: /^(General|Members)$/ })
    await ownerSettingsSelect.tap()
    const ownerMembersOption = page.getByRole("option", { name: "Members" })
    await expect(ownerMembersOption).toBeVisible()
    await ownerMembersOption.tap()
    await expect(ownerSettingsSelect).toHaveText("Members")

    const readerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    try {
      const reader = await readerContext.newPage()
      const readerUser = await devLogin(reader, `top-doc-phone-reader-${testId}@example.com`, `Phone reader ${testId}`)
      await expectApiOk(
        await reader.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
          data: { role: "member", name: readerUser.name },
        }),
        "Join workspace as a phone reader"
      )
      await reader.goto(`/w/${workspaceId}/s/${docId}`)
      const editor = pane(reader, docId).locator(".ProseMirror")
      await expect(editor).toHaveAttribute("contenteditable", "false", { timeout: 15000 })
      await reader.getByRole("button", { name: "Join Doc", exact: true }).tap()
      await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
      await editor.tap()
      await reader.keyboard.press("ControlOrMeta+End")
      await reader.keyboard.type(`Phone edit ${testId}`)
      await expect(editor).toContainText(`Phone edit ${testId}`)
      await expect(ownerEditor).toContainText(`Phone edit ${testId}`, { timeout: 15000 })

      const settings = await openSettings(reader, docId, true)
      const settingsSelect = settings.getByRole("combobox").filter({ hasText: /^(General|Members)$/ })
      await expect(settingsSelect).toHaveText("General")
      await settingsSelect.tap()
      const membersOption = reader.getByRole("option", { name: "Members" })
      await expect(membersOption).toBeVisible()
      await membersOption.tap()
      await expect(settingsSelect).toHaveText("Members")
      await expect(settings.getByPlaceholder("Filter members...")).toBeVisible()
    } finally {
      await readerContext.close()
    }
  })
})
