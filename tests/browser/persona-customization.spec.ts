import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import {
  expectApiOk,
  generateTestId,
  loginAndCreateWorkspace,
  loginInNewContext,
  waitForWorkspaceProvisioned,
} from "./helpers"

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
    await expect(dialog.getByRole("listitem").filter({ hasText: "Ariadne" })).toBeVisible({ timeout: 10000 })
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
    await expect(settingsDialog.getByRole("listitem").filter({ hasText: "Ariadne" })).toBeVisible({ timeout: 10000 })

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
    await expect(dialog.getByRole("listitem").filter({ hasText: "Ariadne" })).toBeVisible({ timeout: 10000 })

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

  test("defaults pin at create: a later default change never switches an existing scratchpad's agent", async ({
    page,
  }) => {
    test.setTimeout(60000)

    const { testId } = await loginAndCreateWorkspace(page, "persona-default")
    const workspaceId = page.url().match(/\/w\/(ws_[^/]+)/)![1]
    const wsAgentName = `Workspace pick ${testId}`
    const userAgentName = `Personal pick ${testId}`

    // Two custom personas (forked via API for speed) give the workspace tier and
    // the personal tier distinct, assertable names.
    for (const name of [wsAgentName, userAgentName]) {
      const forkRes = await page.request.post(`/api/workspaces/${workspaceId}/personas`, {
        data: { sourcePersonaId: "persona_system_ariadne", name },
      })
      await expectApiOk(forkRes, `Persona fork (${name})`)
    }

    // ──── Admin sets the workspace default via the Personas tab combobox ────

    await page.goto(`/w/${workspaceId}?ws-settings=ai-agents`)
    const settingsDialog = page.getByRole("dialog")
    const wsDefaultPicker = settingsDialog.getByRole("combobox", { name: "Companion agent" })
    await expect(wsDefaultPicker).toBeEnabled({ timeout: 10000 })
    const wsSettingsSaved = page.waitForResponse(
      (r) => r.url().includes("/workspace-settings") && r.request().method() === "PATCH" && r.ok()
    )
    await wsDefaultPicker.click()
    await page.getByRole("option", { name: wsAgentName }).click()
    await expect(wsDefaultPicker).toContainText(wsAgentName)
    await wsSettingsSaved

    // ──── A scratchpad created with NO explicit pick PINS the workspace default ────

    const createRes = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "scratchpad", displayName: `pad-${testId}` },
    })
    await expectApiOk(createRes, "Scratchpad creation")
    const streamId = ((await createRes.json()) as { stream: { id: string } }).stream.id
    const created = ((await createRes.json()) as { stream: { companionPersonaId: string | null } }).stream
    // The default resolves at create and the concrete id is written — never a
    // null pointer to be re-resolved later.
    expect(created.companionPersonaId).not.toBeNull()

    const companionUrl = `/w/${workspaceId}/s/${streamId}?stream-settings=companion&sid=${streamId}`
    await page.goto(companionUrl)
    const streamPicker = page.getByRole("combobox", { name: "Companion agent" })
    await expect(streamPicker).toContainText(wsAgentName, { timeout: 10000 })

    // ──── Changing defaults later must NOT touch the existing scratchpad ────

    await page.goto(`/w/${workspaceId}?settings=ai`)
    const userDefaultPicker = page.getByRole("combobox", { name: "Companion agent" })
    // The synthetic leading option names the tier it would inherit (the workspace pick).
    await expect(userDefaultPicker).toContainText(wsAgentName, { timeout: 10000 })
    const preferenceSaved = page.waitForResponse(
      (r) => r.url().includes("/preferences") && r.request().method() === "PATCH" && r.ok()
    )
    await userDefaultPicker.click()
    await page.getByRole("option", { name: userAgentName }).click()
    await expect(userDefaultPicker).toContainText(userAgentName)
    await preferenceSaved

    // The existing scratchpad stays on the persona it was created with — a
    // default change never switches an agent mid-scratchpad.
    await page.goto(companionUrl)
    await expect(page.getByRole("combobox", { name: "Companion agent" })).toContainText(wsAgentName, {
      timeout: 10000,
    })

    // ──── A NEW scratchpad pins the current default (the personal pick) ────

    const createRes2 = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
      data: { type: "scratchpad", displayName: `pad2-${testId}` },
    })
    await expectApiOk(createRes2, "Second scratchpad creation")
    const streamId2 = ((await createRes2.json()) as { stream: { id: string } }).stream.id
    await page.goto(`/w/${workspaceId}/s/${streamId2}?stream-settings=companion&sid=${streamId2}`)
    await expect(page.getByRole("combobox", { name: "Companion agent" })).toContainText(userAgentName, {
      timeout: 10000,
    })
  })

  /**
   * User-scoped personas cross-user contract (user-scoped-personas step 4).
   *
   * A workspace admin (user A) creates the workspace; a plain member (user B)
   * forks a personal persona. Two invariants are proven end to end against real
   * store-driven UI (no live AI turn):
   *
   *  - OWNER lifecycle + visibility: the member forks from a built-in, edits and
   *    saves in the editor, sees the row under "My personas", picks it as a
   *    scratchpad companion (with the muted "Personal" tag) and the pin persists,
   *    sees it in their own @mention suggestions, then archives it (it leaves the
   *    picker) and unarchives it from the "My personas" archived disclosure.
   *  - CROSS-USER INVISIBILITY: while that personal persona is active, the admin
   *    never sees it — not in the AI Agents roster, not in the workspace-default
   *    picker options, not in their own scratchpad companion picker, not in their
   *    @mention suggestions. The admin's Ariadne rows/options are asserted present
   *    as positive controls so an absent-personal check can't pass on a dead menu.
   *
   * One spec composes both flows so the two-user workspace is provisioned once.
   */
  test("personal persona: owner lifecycle + visibility, invisible to the workspace admin", async ({
    page,
    browser,
  }) => {
    test.setTimeout(180000)

    // ──── User A: admin (workspace creator, default page fixture) ────
    const adminPage = page
    let memberCtx: { context: BrowserContext; page: Page } | undefined

    try {
      await loginAndCreateWorkspace(adminPage, "persona-admin")
      const workspaceId = adminPage.url().match(/\/w\/(ws_[^/]+)/)![1]

      // ──── User B: plain member joins the workspace ────
      memberCtx = await loginInNewContext(browser, `persona-member-${generateTestId()}@example.com`, "Persona Member")
      const memberPage = memberCtx.page
      const joinRes = await memberPage.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
        data: { role: "member" },
      })
      await expectApiOk(joinRes, "Member join workspace")
      await waitForWorkspaceProvisioned(memberPage, workspaceId)

      const testId = generateTestId()
      const personaName = `Nightowl ${testId}`
      const personaDescription = `Personal night-shift companion ${testId}`

      // ════════════ OWNER: fork a personal persona through "My personas" ════════════

      await memberPage.goto(`/w/${workspaceId}?settings=ai`)
      // The "New persona" button lives in the My personas section (personal fork).
      await expect(memberPage.getByRole("heading", { name: "My personas" })).toBeVisible({ timeout: 10000 })
      await memberPage.getByRole("button", { name: "New persona" }).click()

      const forkDialog = memberPage.getByRole("dialog").filter({ hasText: "Fork an existing persona" })
      await expect(forkDialog).toBeVisible({ timeout: 10000 })
      // Pick the built-in Ariadne as the fork source explicitly. Selecting it (vs
      // relying on the default) also waits out the just-joined member's persona
      // store hydrating — before it does, the source list is empty and Create is
      // disabled.
      await forkDialog.getByRole("combobox").click()
      await memberPage.getByRole("option", { name: "Ariadne" }).click()
      await forkDialog.getByRole("textbox", { name: "Name" }).fill(personaName)
      const createButton = forkDialog.getByRole("button", { name: "Create" })
      await expect(createButton).toBeEnabled({ timeout: 10000 })
      await createButton.click()

      // Lands in the full custom editor for the just-forked personal persona.
      await expect(memberPage).toHaveURL(/\/settings\/personas\/persona_/, { timeout: 10000 })
      await expect(memberPage.getByRole("heading", { name: `Edit ${personaName}` })).toBeVisible({ timeout: 10000 })
      const personaId = memberPage.url().match(/\/settings\/personas\/(persona_[^/?]+)/)![1]

      // ──── Edit a plain field and save ────
      await memberPage.getByRole("textbox", { name: "Description" }).fill(personaDescription)
      const save = memberPage.getByRole("button", { name: "Save" })
      await expect(save).toBeEnabled()
      await save.click()
      await expect(save).toBeDisabled({ timeout: 10000 })

      // ──── Back on My personas the saved row is listed ────
      await memberPage.goto(`/w/${workspaceId}?settings=ai`)
      await expect(memberPage.getByText(personaName)).toBeVisible({ timeout: 10000 })

      // ════════════ OWNER: pick it as a scratchpad companion (with "Personal" tag) ════════════

      const padRes = await memberPage.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "scratchpad", displayName: `owner-pad-${testId}` },
      })
      await expectApiOk(padRes, "Member scratchpad creation")
      const streamId = ((await padRes.json()) as { stream: { id: string } }).stream.id

      const companionUrl = `/w/${workspaceId}/s/${streamId}?stream-settings=companion&sid=${streamId}`
      await memberPage.goto(companionUrl)
      const memberPicker = memberPage.getByRole("combobox", { name: "Companion agent" })
      await expect(memberPicker).toBeVisible({ timeout: 10000 })
      await memberPicker.click()
      const personalOption = memberPage.getByRole("option", { name: new RegExp(personaName) })
      await expect(personalOption).toBeVisible({ timeout: 10000 })
      // The muted "Personal" tag marks a user-owned persona in the picker.
      await expect(personalOption).toContainText("Personal")
      await personalOption.click()
      await expect(memberPicker).toContainText(personaName)

      // Reload: the personal companion pointer persisted on the scratchpad row.
      await memberPage.goto(companionUrl)
      await expect(memberPage.getByRole("combobox", { name: "Companion agent" })).toContainText(personaName, {
        timeout: 10000,
      })

      // ════════════ OWNER: it appears in their own @mention suggestions ════════════

      await memberPage.goto(`/w/${workspaceId}/s/${streamId}`)
      await typeMention(memberPage, personaName.split(" ")[0])
      await expect(
        memberPage.locator("[aria-label='Mention suggestions']").getByRole("option", { name: new RegExp(personaName) })
      ).toBeVisible({ timeout: 10000 })

      // ════════════ ADMIN: the personal persona is invisible everywhere ════════════

      // (1) Not in the AI Agents workspace roster.
      await adminPage.goto(`/w/${workspaceId}?ws-settings=ai-agents`)
      const adminSettings = adminPage.getByRole("dialog")
      await expect(adminSettings.getByRole("listitem").filter({ hasText: "Ariadne" })).toBeVisible({ timeout: 10000 })
      await expect(adminSettings.getByText(personaName)).toHaveCount(0)

      // (2) Not among the workspace-default picker options (Ariadne present).
      const wsDefaultPicker = adminSettings.getByRole("combobox", { name: "Companion agent" })
      await expect(wsDefaultPicker).toBeEnabled({ timeout: 10000 })
      await wsDefaultPicker.click()
      await expect(adminPage.getByRole("option", { name: /Ariadne/ })).toBeVisible({ timeout: 10000 })
      await expect(adminPage.getByRole("option", { name: new RegExp(personaName) })).toHaveCount(0)
      await adminPage.keyboard.press("Escape")

      // (3) Not in the admin's own scratchpad companion picker (Ariadne present).
      const adminPadRes = await adminPage.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "scratchpad", displayName: `admin-pad-${testId}` },
      })
      await expectApiOk(adminPadRes, "Admin scratchpad creation")
      const adminStreamId = ((await adminPadRes.json()) as { stream: { id: string } }).stream.id
      await adminPage.goto(`/w/${workspaceId}/s/${adminStreamId}?stream-settings=companion&sid=${adminStreamId}`)
      const adminPicker = adminPage.getByRole("combobox", { name: "Companion agent" })
      await expect(adminPicker).toBeVisible({ timeout: 10000 })
      await adminPicker.click()
      await expect(adminPage.getByRole("option", { name: /Ariadne/ })).toBeVisible({ timeout: 10000 })
      await expect(adminPage.getByRole("option", { name: new RegExp(personaName) })).toHaveCount(0)
      await adminPage.keyboard.press("Escape")

      // (4) Not in the admin's @mention suggestions (Ariadne present as control).
      await adminPage.goto(`/w/${workspaceId}/s/${adminStreamId}`)
      await typeMention(adminPage, "Ariadne")
      await expect(
        adminPage.locator("[aria-label='Mention suggestions']").getByRole("option", { name: /Ariadne/ })
      ).toBeVisible({ timeout: 10000 })
      await clearComposer(adminPage)
      await typeMention(adminPage, personaName.split(" ")[0])
      await expect(adminPage.getByRole("option", { name: new RegExp(personaName) })).toHaveCount(0)

      // ════════════ OWNER: archive removes it from the picker, unarchive restores it ════════════

      await memberPage.goto(`/w/${workspaceId}/settings/personas/${personaId}`)
      await expect(memberPage.getByRole("heading", { name: `Edit ${personaName}` })).toBeVisible({ timeout: 10000 })
      await memberPage.getByRole("button", { name: "Archive", exact: true }).click()
      const confirm = memberPage.getByRole("alertdialog")
      await confirm.getByRole("button", { name: "Archive", exact: true }).click()
      // A personal persona returns its owner to personal AI settings.
      await expect(memberPage).toHaveURL(/settings=ai/, { timeout: 10000 })

      // Archived: the scratchpad companion picker no longer offers it.
      await memberPage.goto(companionUrl)
      const memberPickerAfterArchive = memberPage.getByRole("combobox", { name: "Companion agent" })
      await expect(memberPickerAfterArchive).toBeVisible({ timeout: 10000 })
      await memberPickerAfterArchive.click()
      await expect(memberPage.getByRole("option", { name: /Ariadne/ })).toBeVisible({ timeout: 10000 })
      await expect(memberPage.getByRole("option", { name: new RegExp(personaName) })).toHaveCount(0)
      await memberPage.keyboard.press("Escape")

      // Unarchive from the "My personas" Archived disclosure returns it to the active roster.
      await memberPage.goto(`/w/${workspaceId}?settings=ai`)
      const archivedToggle = memberPage.getByRole("button", { name: /Archived/ })
      await expect(archivedToggle).toBeVisible({ timeout: 10000 })
      await archivedToggle.click()
      await memberPage.getByRole("button", { name: "Unarchive" }).click()
      // Back as an active row with an Edit link.
      await expect(
        memberPage.getByRole("listitem").filter({ hasText: personaName }).getByRole("link", { name: "Edit" })
      ).toBeVisible({ timeout: 10000 })
    } finally {
      await memberCtx?.context.close()
    }
  })
})

/** Focus the main composer and type an @-mention trigger, opening the suggestion popup. */
async function typeMention(page: Page, query: string): Promise<void> {
  const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
  await expect(composer).toBeVisible({ timeout: 15000 })
  await composer.click()
  await page.keyboard.type(`@${query}`)
}

/** Clear the main composer between two mention probes. */
async function clearComposer(page: Page): Promise<void> {
  const composer = page.locator("[data-editor-zone='main'] [contenteditable='true']").last()
  await composer.click()
  await composer.press("ControlOrMeta+a")
  await page.keyboard.press("Backspace")
}
