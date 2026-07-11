import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * Persona editor E2E (roadmap 7.1). Exercises the workspace-settings → Personas
 * tab → full editor flow for the one editable built-in (Ariadne):
 * 1. Open the Personas settings tab and Edit Ariadne.
 * 2. Rewrite the system prompt and toggle a tool off.
 * 3. See per-field "Customized" badges appear.
 * 4. Save the override.
 * 5. Reload and confirm the override persisted (prompt + customized state).
 *
 * No live AI turn is asserted — the override write/read path is the surface here.
 */
test.describe("Persona editor", () => {
  test("admin edits Ariadne's prompt and tools, saves, and the override persists", async ({ page }) => {
    test.setTimeout(60000)

    const { testId } = await loginAndCreateWorkspace(page, "persona-e2e")
    const workspaceId = page.url().match(/\/w\/(ws_[^/]+)/)![1]

    // ──── Open the AI Agents settings tab and enter the editor ────

    await page.goto(`/w/${workspaceId}?ws-settings=ai-agents`)
    const settingsDialog = page.getByRole("dialog")
    await expect(settingsDialog.getByText("Ariadne", { exact: true })).toBeVisible({ timeout: 10000 })
    // Fresh workspace — Ariadne has no override yet.
    await expect(settingsDialog.getByText("Customized")).toHaveCount(0)

    await settingsDialog.getByRole("link", { name: "Edit" }).click()
    await expect(page).toHaveURL(new RegExp(`/settings/personas/persona_system_ariadne`))
    await expect(page.getByRole("heading", { name: "Edit Ariadne" })).toBeVisible({ timeout: 10000 })

    // ──── Edit the system prompt and toggle a tool off ────

    const marker = `You are the E2E test persona ${testId}. Keep replies short.`
    // The system prompt is a RichEditor (contenteditable), not a plain textarea:
    // click in, select-all, replace with the marker.
    const systemPrompt = page.getByRole("textbox", { name: "Persona system prompt editor" })
    await systemPrompt.click()
    await page.keyboard.press("ControlOrMeta+A")
    await page.keyboard.press("Delete")
    await page.keyboard.type(marker)
    await expect(systemPrompt).toContainText(marker)

    // Web search is enabled by default; unchecking it diverges the tool set.
    const webSearch = page.getByRole("checkbox", { name: "Web search" })
    await expect(webSearch).toBeChecked()
    await webSearch.click()
    await expect(webSearch).not.toBeChecked()

    // Per-field "Customized" markers now appear (system prompt + tools diverge).
    await expect(page.getByText("Customized").first()).toBeVisible()

    // ──── Save the override ────

    const save = page.getByRole("button", { name: "Save" })
    await expect(save).toBeEnabled()
    await save.click()
    // A committed override is not dirty, so Save disables itself (no toast, INV-63).
    await expect(save).toBeDisabled({ timeout: 10000 })

    // ──── Reload: the override must survive a fresh fetch ────

    await page.reload()
    await expect(page.getByRole("heading", { name: "Edit Ariadne" })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole("textbox", { name: "Persona system prompt editor" })).toContainText(marker)
    await expect(page.getByRole("checkbox", { name: "Web search" })).not.toBeChecked()
    await expect(page.getByText("Customized").first()).toBeVisible()

    // The list row reflects the override too (isCustomized from GET /personas).
    await page.goto(`/w/${workspaceId}?ws-settings=ai-agents`)
    await expect(page.getByRole("dialog").getByText("Customized")).toBeVisible({ timeout: 10000 })
  })
})
