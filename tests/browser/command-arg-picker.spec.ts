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
 * so we inject a `/model` command into the bootstrap responses.
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

async function injectModelCommand(route: Route) {
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
    const existing = Array.isArray(data.commands) ? (data.commands as { name?: string }[]) : []
    data.commands = [...existing.filter((c) => c.name !== MODEL_COMMAND.name), MODEL_COMMAND]
  }
  await route.fulfill({ response, json: body })
}

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
})
