import { test, expect } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace } from "./helpers"

/**
 * Persona roster + editors E2E (roadmap 7.1/7.2). Covers the shipped model:
 * built-in agents (Ariadne) have BOUNDED editing (tools/model/style presets +
 * a read-only prompt), while fully editable customs are created by forking.
 *
 * 1. Built-in editor is restricted: model/tone/brevity/tools are editable and the
 *    system prompt is read-only — the editable prompt contenteditable the custom
 *    editor exposes does not exist for a system persona. Saving a tool override
 *    persists.
 * 2. Fork flow: New agent → pick source → name → lands in the full custom editor;
 *    a plain-field edit saves; the custom is set as a scratchpad's companion via
 *    the picker and the pointer persists.
 * 3. Archive a custom from its editor, then unarchive it from the roster's
 *    Archived disclosure.
 *
 * No live AI turn is asserted — the config/companion write-and-read paths are the
 * surface here. The RichEditor prompt is a contenteditable, so tests drive plain
 * inputs (never fill()/toHaveValue() on the editor).
 */
test.describe("Persona roster + editors", () => {
  test("built-in editor is restricted to tools/model/style with a read-only prompt", async ({ page }) => {
    test.setTimeout(60000)

    await loginAndCreateWorkspace(page, "persona-builtin")
    const workspaceId = page.url().match(/\/w\/(ws_[^/]+)/)![1]

    // ──── Open the AI Agents tab and enter Ariadne's editor ────

    await page.goto(`/w/${workspaceId}?ws-settings=ai-agents`)
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Ariadne", { exact: true })).toBeVisible({ timeout: 10000 })
    // Fresh workspace — Ariadne has no override yet.
    await expect(dialog.getByText("Customized")).toHaveCount(0)

    await dialog.getByRole("listitem").filter({ hasText: "Ariadne" }).getByRole("link", { name: "Edit" }).click()
    await expect(page).toHaveURL(new RegExp("/settings/personas/persona_system_ariadne"))
    await expect(page.getByRole("heading", { name: "Edit Ariadne" })).toBeVisible({ timeout: 10000 })

    // ──── The bounded surface: model + style presets + tools, prompt read-only ────

    await expect(page.getByText("Model", { exact: true })).toBeVisible()
    await expect(page.getByText("Tone", { exact: true })).toBeVisible()
    await expect(page.getByText("Brevity", { exact: true })).toBeVisible()
    await expect(page.getByRole("checkbox", { name: "Web search" })).toBeVisible()

    // The system prompt is locked for a system persona — it renders read-only, so
    // the editable contenteditable the custom editor exposes must NOT exist here.
    await expect(page.getByRole("textbox", { name: "Persona system prompt editor" })).toHaveCount(0)
    await expect(page.getByText("Read-only")).toBeVisible()

    // ──── Edit an allowed knob (a tool) and save the override ────

    const webSearch = page.getByRole("checkbox", { name: "Web search" })
    await expect(webSearch).toBeChecked()
    await webSearch.click()
    await expect(webSearch).not.toBeChecked()
    // The tool set now diverges from the built-in default (FieldRow "Customized").
    await expect(page.getByText("Customized").first()).toBeVisible()

    const save = page.getByRole("button", { name: "Save" })
    await expect(save).toBeEnabled()
    await save.click()
    // A committed override is not dirty, so Save disables itself (no toast, INV-63).
    await expect(save).toBeDisabled({ timeout: 10000 })

    // ──── Reload: the override survives a fresh fetch ────

    await page.reload()
    await expect(page.getByRole("heading", { name: "Edit Ariadne" })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole("checkbox", { name: "Web search" })).not.toBeChecked()

    // The roster row reflects the override (isCustomized from GET /personas). The
    // legacy `personas` alias still resolves to the AI Agents tab.
    await page.goto(`/w/${workspaceId}?ws-settings=personas`)
    await expect(page.getByRole("dialog").getByText("Customized")).toBeVisible({ timeout: 10000 })
  })

  test("fork Ariadne into a custom, edit and save, then set it as a scratchpad's companion", async ({ page }) => {
    test.setTimeout(60000)

    const { testId } = await loginAndCreateWorkspace(page, "persona-fork")
    const workspaceId = page.url().match(/\/w\/(ws_[^/]+)/)![1]
    const agentName = `Research assistant ${testId}`

    // ──── New agent → fork the default source (Ariadne) → name → Create ────

    await page.goto(`/w/${workspaceId}?ws-settings=ai-agents`)
    const settingsDialog = page.getByRole("dialog")
    await expect(settingsDialog.getByText("Ariadne", { exact: true })).toBeVisible({ timeout: 10000 })

    await settingsDialog.getByRole("button", { name: "New agent" }).click()
    const forkDialog = page.getByRole("dialog").filter({ hasText: "Fork an existing agent" })
    await forkDialog.getByRole("textbox", { name: "Name" }).fill(agentName)
    await forkDialog.getByRole("button", { name: "Create" }).click()

    // Lands in the full custom editor at its own persona URL.
    await expect(page).toHaveURL(/\/settings\/personas\/persona_/)
    await expect(page.getByRole("heading", { name: `Edit ${agentName}` })).toBeVisible({ timeout: 10000 })

    // The custom editor exposes the full editing the built-in one locks: an
    // editable name and an editable system-prompt contenteditable.
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(agentName)
    await expect(page.getByRole("textbox", { name: "Persona system prompt editor" })).toBeVisible()

    // ──── Edit a plain field and save (the RichEditor is left untouched) ────

    const description = page.getByRole("textbox", { name: "Description" })
    await description.fill(`Focused research companion ${testId}`)
    const save = page.getByRole("button", { name: "Save" })
    await expect(save).toBeEnabled()
    await save.click()
    await expect(save).toBeDisabled({ timeout: 10000 })

    await page.reload()
    await expect(page.getByRole("textbox", { name: "Description" })).toHaveValue(
      `Focused research companion ${testId}`,
      { timeout: 10000 }
    )

    // ──── Set the custom as a scratchpad's companion via the picker ────

    const createRes = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "scratchpad", displayName: `pad-${testId}` },
    })
    await expectApiOk(createRes, "Scratchpad creation")
    const streamId = ((await createRes.json()) as { stream: { id: string } }).stream.id

    const companionUrl = `/w/${workspaceId}/s/${streamId}?stream-settings=companion&sid=${streamId}`
    await page.goto(companionUrl)
    const picker = page.getByRole("combobox", { name: "Companion agent" })
    await expect(picker).toBeVisible({ timeout: 10000 })
    await picker.click()
    await page.getByRole("option", { name: agentName }).click()
    // The trigger now shows the selected custom agent.
    await expect(picker).toContainText(agentName)

    // Reload: the companion pointer persisted on the stream row.
    await page.goto(companionUrl)
    await expect(page.getByRole("combobox", { name: "Companion agent" })).toContainText(agentName, { timeout: 10000 })
  })

  test("archive a custom from its editor, then unarchive it from the roster disclosure", async ({ page }) => {
    test.setTimeout(60000)

    const { testId } = await loginAndCreateWorkspace(page, "persona-archive")
    const workspaceId = page.url().match(/\/w\/(ws_[^/]+)/)![1]
    const agentName = `Scratch agent ${testId}`

    // Fork via the API for speed — the fork UI is covered above.
    const forkRes = await page.request.post(`/api/workspaces/${workspaceId}/personas`, {
      data: { sourcePersonaId: "persona_system_ariadne", name: agentName },
    })
    await expectApiOk(forkRes, "Persona fork")
    const personaId = ((await forkRes.json()) as { persona: { id: string } }).persona.id

    // ──── Archive it from its editor (danger-zone action + confirmation) ────

    await page.goto(`/w/${workspaceId}/settings/personas/${personaId}`)
    await expect(page.getByRole("heading", { name: `Edit ${agentName}` })).toBeVisible({ timeout: 10000 })

    await page.getByRole("button", { name: "Archive", exact: true }).click()
    const confirm = page.getByRole("alertdialog")
    await confirm.getByRole("button", { name: "Archive", exact: true }).click()

    // Lands back on the AI Agents tab; the agent left the active roster.
    await expect(page).toHaveURL(/ws-settings=ai-agents/)
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByText("Ariadne", { exact: true })).toBeVisible({ timeout: 10000 })

    // ──── It sits behind the Archived disclosure; unarchive returns it ────

    const archivedToggle = dialog.getByRole("button", { name: /Archived/ })
    await expect(archivedToggle).toBeVisible({ timeout: 10000 })
    await archivedToggle.click()
    await expect(dialog.getByText(agentName)).toBeVisible()

    await dialog.getByRole("button", { name: "Unarchive" }).click()
    // Back on the active roster as an editable row.
    await expect(
      dialog.getByRole("listitem").filter({ hasText: agentName }).getByRole("link", { name: "Edit" })
    ).toBeVisible({ timeout: 10000 })
  })
})
