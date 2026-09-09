import { test, expect, type Route } from "@playwright/test"
import { expectApiOk, generateTestId, loginInNewContext, waitForWorkspaceProvisioned } from "./helpers"

/**
 * Command-argument option picker E2E.
 *
 * When a slash command advertises `args[].suggestions` (in production the model
 * list a linked Pi runtime sends), picking it opens a mention-style popover to
 * choose the value instead of typing it. Tests cover the parts that can't be
 * unit-tested: the popover opening after the command chip, live filtering by the
 * text typed after the command, keyboard navigation, and that Enter selects an
 * option (preempting send) and inserts it as `/model <value>`.
 *
 * The suggestions normally come from a Pi runtime, which isn't present in tests,
 * so we inject `/model` and `/spawn` into the bootstrap responses. `/spawn` also
 * covers the per-choice lists: naming a runtime switches `/model` to that
 * runtime's own models, which is the whole point of spawning across runtimes.
 */

const MODEL_COMMAND = {
  name: "model",
  description: "Switch the active model",
  kind: "bot-runtime",
  scope: "stream",
  args: [
    {
      name: "model",
      required: true,
      suggestions: [
        { value: "anthropic/claude-opus-4", label: "Claude Opus 4" },
        { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
        { value: "openai/gpt-5", label: "GPT-5", description: "OpenAI flagship" },
      ],
    },
  ],
}

const CLAUDE_MODELS = [{ value: "opus", label: "Opus" }]
const PI_MODELS = [{ value: "openai-codex/gpt-5.6-luna", label: "GPT-5.6 Luna" }]

const SPAWN_COMMAND = {
  name: "spawn",
  description: "Start a coding session in a thread under this scratchpad",
  kind: "bot-runtime",
  scope: "stream",
  args: [
    {
      name: "runtime",
      suggestions: [
        { value: "claude", label: "Claude Code", args: [{ name: "/model", suggestions: CLAUDE_MODELS }] },
        {
          value: "pi",
          label: "Pi",
          args: [
            { name: "/model", suggestions: PI_MODELS },
            { name: "/thinking", suggestions: [{ value: "off" }, { value: "medium" }] },
          ],
        },
      ],
    },
    { name: "/model", suggestions: CLAUDE_MODELS },
    { name: "/thinking", suggestions: [{ value: "low" }, { value: "high" }] },
    { name: "name", required: true, description: "Session name" },
  ],
}

/**
 * What production sends while the linked runtime process predates the
 * per-runtime capability: the overrides exist as arguments (the runtime parser
 * takes them) but nothing advertised a list for either one.
 */
const BARE_SPAWN_COMMAND = {
  ...SPAWN_COMMAND,
  args: [
    {
      name: "runtime",
      suggestions: [
        { value: "claude", label: "Claude Code" },
        { value: "pi", label: "Pi" },
      ],
    },
    { name: "/model", description: "Model for the spawned session" },
    { name: "/thinking", description: "Thinking level for the spawned session" },
    { name: "name", required: true, description: "Session name" },
  ],
}

function injectCommands(...commands: { name: string }[]) {
  return async (route: Route) => {
    const response = await route.fetch()
    let body: unknown
    try {
      body = await response.json()
    } catch {
      await route.fulfill({ response })
      return
    }
    const data = (body as { data?: { commands?: unknown } } | null)?.data
    if (data && typeof data === "object") {
      const names = new Set(commands.map((command) => command.name))
      const existing = Array.isArray(data.commands) ? (data.commands as { name?: string }[]) : []
      data.commands = [...existing.filter((c) => !names.has(c.name ?? "")), ...commands]
    }
    await route.fulfill({ response, json: body })
  }
}

const injectModelCommand = injectCommands(MODEL_COMMAND)

test.describe("Command argument option picker", () => {
  test("picks a model option from the popover with the keyboard", async ({ browser }) => {
    test.setTimeout(60000)
    const ctx = await loginInNewContext(browser, `argpicker-${Date.now()}@example.com`, "ArgPicker")

    try {
      const testId = generateTestId()
      const wsRes = await ctx.page.request.post("/api/workspaces", { data: { name: `ArgPicker WS ${testId}` } })
      await expectApiOk(wsRes, "Workspace creation")
      const { workspace } = (await wsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctx.page, workspaceId)

      const channelSlug = `argpick-${testId}`
      const streamRes = await ctx.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      await expectApiOk(streamRes, "Create public channel")
      const { stream } = (await streamRes.json()) as { stream: { id: string } }

      // Advertise the model options the way a linked Pi runtime would.
      await ctx.page.route("**/bootstrap*", injectModelCommand)

      await ctx.page.goto(`/w/${workspaceId}/s/${stream.id}`)
      await expect(ctx.page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

      const editor = ctx.page.locator("[contenteditable='true']")
      await editor.click()

      // Open the slash palette and pick /model.
      await ctx.page.keyboard.type("/model")
      const commandPopup = ctx.page.locator("[aria-label='Slash command suggestions']")
      await expect(commandPopup).toBeVisible({ timeout: 5000 })
      await commandPopup.getByRole("option", { name: /model/ }).first().click()

      // The option picker opens with every advertised model.
      const argPopup = ctx.page.locator("[aria-label='Command option suggestions']")
      await expect(argPopup).toBeVisible({ timeout: 5000 })
      await expect(argPopup.getByRole("option", { name: /Claude Opus 4/ })).toBeVisible()
      await expect(argPopup.getByRole("option", { name: /Claude Sonnet 4/ })).toBeVisible()
      await expect(argPopup.getByRole("option", { name: /GPT-5/ })).toBeVisible()

      // Typing after the command filters the options.
      await ctx.page.keyboard.type("claude")
      await expect(argPopup.getByRole("option", { name: /Claude Sonnet 4/ })).toBeVisible()
      await expect(argPopup.getByRole("option", { name: /GPT-5/ })).not.toBeVisible()

      // ArrowDown moves off the first match; Enter selects it (instead of sending
      // the message) and inserts the chosen value.
      await ctx.page.keyboard.press("ArrowDown")
      await ctx.page.keyboard.press("Enter")
      await expect(argPopup).not.toBeVisible()
      await expect(editor).toContainText("/model")
      await expect(editor).toContainText("anthropic/claude-sonnet-4")
    } finally {
      await ctx.context.close()
    }
  })

  test("dismisses the picker on Escape, leaving the command for free-form typing", async ({ browser }) => {
    test.setTimeout(60000)
    const ctx = await loginInNewContext(browser, `argpicker-esc-${Date.now()}@example.com`, "ArgPickerEsc")

    try {
      const testId = generateTestId()
      const wsRes = await ctx.page.request.post("/api/workspaces", { data: { name: `ArgPicker WS ${testId}` } })
      await expectApiOk(wsRes, "Workspace creation")
      const { workspace } = (await wsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctx.page, workspaceId)

      const channelSlug = `argpick-esc-${testId}`
      const streamRes = await ctx.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      await expectApiOk(streamRes, "Create public channel")
      const { stream } = (await streamRes.json()) as { stream: { id: string } }

      await ctx.page.route("**/bootstrap*", injectModelCommand)

      await ctx.page.goto(`/w/${workspaceId}/s/${stream.id}`)
      await expect(ctx.page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

      const editor = ctx.page.locator("[contenteditable='true']")
      await editor.click()
      await ctx.page.keyboard.type("/model")
      const commandPopup = ctx.page.locator("[aria-label='Slash command suggestions']")
      await expect(commandPopup).toBeVisible({ timeout: 5000 })
      await commandPopup.getByRole("option", { name: /model/ }).first().click()

      const argPopup = ctx.page.locator("[aria-label='Command option suggestions']")
      await expect(argPopup).toBeVisible({ timeout: 5000 })

      await ctx.page.keyboard.press("Escape")
      await expect(argPopup).not.toBeVisible()

      // The command chip is still there and the user can type the value by hand.
      await ctx.page.keyboard.type("custom-model")
      await expect(editor).toContainText("/model")
      await expect(editor).toContainText("custom-model")
    } finally {
      await ctx.context.close()
    }
  })

  test("offers no override when the linked runtime advertised no lists for it", async ({ browser }) => {
    test.setTimeout(60000)
    const ctx = await loginInNewContext(browser, `argpicker-bare-${Date.now()}@example.com`, "ArgPickerBare")

    try {
      const testId = generateTestId()
      const wsRes = await ctx.page.request.post("/api/workspaces", { data: { name: `ArgPicker WS ${testId}` } })
      await expectApiOk(wsRes, "Workspace creation")
      const { workspace } = (await wsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctx.page, workspaceId)

      const channelSlug = `argpick-bare-${testId}`
      const streamRes = await ctx.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      await expectApiOk(streamRes, "Create public channel")
      const { stream } = (await streamRes.json()) as { stream: { id: string } }

      await ctx.page.route("**/bootstrap*", injectCommands(BARE_SPAWN_COMMAND))

      await ctx.page.goto(`/w/${workspaceId}/s/${stream.id}`)
      await expect(ctx.page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

      const editor = ctx.page.locator("[contenteditable='true']")
      await editor.click()
      await ctx.page.keyboard.type("/spawn")
      const commandPopup = ctx.page.locator("[aria-label='Slash command suggestions']")
      await expect(commandPopup).toBeVisible({ timeout: 5000 })
      await commandPopup.getByRole("option", { name: /spawn/ }).first().click()

      // The runtime list still opens — that one has options.
      const argPopup = ctx.page.locator("[aria-label='Command option suggestions']")
      await expect(argPopup).toBeVisible({ timeout: 5000 })
      await argPopup.getByRole("option", { name: /^Pi/ }).click()

      // The overrides carry nothing to pick, so they are not offered at all
      // rather than opening an empty popover the user can't get out of.
      await expect(argPopup).not.toBeVisible()
      await ctx.page.keyboard.type("fix the thing")
      await expect(editor).toContainText("/spawn pi fix the thing")
    } finally {
      await ctx.context.close()
    }
  })

  test("switches the /model list to the runtime named in the /spawn arguments", async ({ browser }) => {
    test.setTimeout(60000)
    const ctx = await loginInNewContext(browser, `argpicker-spawn-${Date.now()}@example.com`, "ArgPickerSpawn")

    try {
      const testId = generateTestId()
      const wsRes = await ctx.page.request.post("/api/workspaces", { data: { name: `ArgPicker WS ${testId}` } })
      await expectApiOk(wsRes, "Workspace creation")
      const { workspace } = (await wsRes.json()) as { workspace: { id: string } }
      const workspaceId = workspace.id
      await waitForWorkspaceProvisioned(ctx.page, workspaceId)

      const channelSlug = `argpick-spawn-${testId}`
      const streamRes = await ctx.page.request.post(`/api/workspaces/${workspaceId}/streams`, {
        data: { type: "channel", slug: channelSlug, visibility: "public" },
      })
      await expectApiOk(streamRes, "Create public channel")
      const { stream } = (await streamRes.json()) as { stream: { id: string } }

      await ctx.page.route("**/bootstrap*", injectCommands(SPAWN_COMMAND))

      await ctx.page.goto(`/w/${workspaceId}/s/${stream.id}`)
      await expect(ctx.page.getByRole("heading", { name: `#${channelSlug}`, level: 1 })).toBeVisible({ timeout: 10000 })

      const editor = ctx.page.locator("[contenteditable='true']")
      await editor.click()
      await ctx.page.keyboard.type("/spawn")
      const commandPopup = ctx.page.locator("[aria-label='Slash command suggestions']")
      await expect(commandPopup).toBeVisible({ timeout: 5000 })
      await commandPopup.getByRole("option", { name: /spawn/ }).first().click()

      // The runtime list opens first; picking Pi leaves the value and offers the
      // overrides themselves, which is the only way to reach one by keyboard.
      const argPopup = ctx.page.locator("[aria-label='Command option suggestions']")
      await expect(argPopup).toBeVisible({ timeout: 5000 })
      await argPopup.getByRole("option", { name: /^Pi/ }).click()
      await expect(argPopup.getByRole("option", { name: "/model" })).toBeVisible()
      await expect(argPopup.getByRole("option", { name: "/thinking" })).toBeVisible()

      // Picking `/model` types the flag and reopens the list on Pi's models —
      // the desk's own Opus is not offered.
      await argPopup.getByRole("option", { name: "/model" }).click()
      await expect(argPopup.getByRole("option", { name: /GPT-5.6 Luna/ })).toBeVisible()
      await expect(argPopup.getByRole("option", { name: /Opus/ })).not.toBeVisible()
      await ctx.page.keyboard.press("ArrowDown")
      await ctx.page.keyboard.press("Enter")

      // The other override takes Pi's levels, in either order, and typing its
      // slash by hand does not open the command palette over the picker.
      await ctx.page.keyboard.type("/thinking ")
      await expect(commandPopup).not.toBeVisible()
      await expect(argPopup).toBeVisible()
      await expect(argPopup.getByRole("option", { name: /medium/ })).toBeVisible()
      await ctx.page.keyboard.type("med")
      await ctx.page.keyboard.press("ArrowDown")
      await ctx.page.keyboard.press("Enter")

      // The session name is free text: no list, and Enter is the editor's again.
      await ctx.page.keyboard.type("fix the thing")
      await expect(argPopup).not.toBeVisible()
      await expect(editor).toContainText("/spawn pi /model openai-codex/gpt-5.6-luna /thinking medium fix the thing")
    } finally {
      await ctx.context.close()
    }
  })
})
