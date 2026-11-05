import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { screen, userEvent, waitFor, within } from "@/test"
import {
  MAX_STATUS_PRESETS,
  SYSTEM_DEFAULT_STATUSES,
  WORKSPACE_PERMISSION_SCOPES,
  presetPausesNotifications,
  type WorkspaceSettings,
} from "@threahq/types"
import { workspaceSettingsApi } from "@/api"
import { settingDef } from "@/components/settings/settings-registry"
import { StatusesTab } from "./statuses-tab"
import { renderWorkspaceSettings } from "./test-harness"

afterEach(() => vi.restoreAllMocks())

describe("StatusesTab", () => {
  it("adds a status from the dialog, refusing one with neither emoji nor name", async () => {
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockImplementation(async (_ws, input) => input as WorkspaceSettings)
    const user = userEvent.setup()
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: { userStatusPresets: SYSTEM_DEFAULT_STATUSES },
    })

    await user.click(screen.getByRole("button", { name: "New status" }))
    const dialog = await screen.findByRole("dialog", { name: "New status" })
    await user.click(within(dialog).getByRole("button", { name: "Save" }))
    const emptyError = within(dialog).getByRole("alert").textContent
    await user.type(within(dialog).getByLabelText("Name"), "Focus time{Enter}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect({
      emptyError,
      texts: update.mock.calls.map((call) => call[1].userStatusPresets?.map((preset) => preset.text)),
    }).toEqual({
      emptyError: "Give the status an emoji or a name.",
      texts: [[...SYSTEM_DEFAULT_STATUSES.map((p) => p.text), "Focus time"]],
    })
  })

  it("edits a preset's name and pause through the dialog", async () => {
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockImplementation(async (_ws, input) => input as WorkspaceSettings)
    const user = userEvent.setup()
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: { userStatusPresets: SYSTEM_DEFAULT_STATUSES },
    })
    const [first, ...rest] = SYSTEM_DEFAULT_STATUSES

    await user.click(screen.getByRole("button", { name: `Edit ${first.text}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit status" })
    const name = within(dialog).getByLabelText("Name")
    await user.clear(name)
    await user.type(name, "Heads down")
    await user.click(within(dialog).getByRole("checkbox", { name: /Pauses notifications/ }))
    await user.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect({
      saved: update.mock.calls.map((call) => call[1].userStatusPresets),
      row: screen.getByRole("button", { name: "Edit Heads down" }).closest("li")?.textContent,
    }).toEqual({
      saved: [[{ ...first, text: "Heads down", pausesNotifications: !presetPausesNotifications(first) }, ...rest]],
      row: expect.stringContaining("Heads down"),
    })
  })

  it("keeps the dialog open with the error inside it when a save fails", async () => {
    vi.spyOn(workspaceSettingsApi, "update").mockRejectedValue(new Error("offline"))
    const toastError = vi.spyOn(toast, "error")
    const user = userEvent.setup()
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: { userStatusPresets: SYSTEM_DEFAULT_STATUSES },
    })
    const [first] = SYSTEM_DEFAULT_STATUSES

    await user.click(screen.getByRole("button", { name: `Edit ${first.text}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit status" })
    await user.click(within(dialog).getByRole("button", { name: "Save" }))

    expect({
      error: (await within(dialog).findByRole("alert")).textContent,
      toasted: toastError.mock.calls.length,
    }).toEqual({ error: "Couldn't save the status. Try again.", toasted: 0 })
  })

  it("saves a removal straight away", async () => {
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockImplementation(async (_ws, input) => input as WorkspaceSettings)
    const user = userEvent.setup()
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: { userStatusPresets: SYSTEM_DEFAULT_STATUSES },
    })

    const [first, ...rest] = SYSTEM_DEFAULT_STATUSES
    await user.click(screen.getByRole("button", { name: `Remove ${first.text}` }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0][1].userStatusPresets?.map((preset) => preset.id)).toEqual(rest.map((p) => p.id))
  })

  it("should keep both removals when the second save would otherwise return first", async () => {
    const resolvers: Array<() => void> = []
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockImplementation(
        (_ws, input) => new Promise((resolve) => resolvers.push(() => resolve(input as WorkspaceSettings)))
      )
    const user = userEvent.setup()
    const { queryClient } = renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: { userStatusPresets: SYSTEM_DEFAULT_STATUSES },
    })
    const [first, second, ...rest] = SYSTEM_DEFAULT_STATUSES

    await user.click(screen.getByRole("button", { name: `Remove ${first!.text}` }))
    await user.click(screen.getByRole("button", { name: `Remove ${second!.text}` }))
    // Answer whatever is in flight newest first, the way a slower first round trip would.
    resolvers
      .splice(0)
      .reverse()
      .forEach((resolve) => resolve())
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    resolvers.splice(0).forEach((resolve) => resolve())

    await waitFor(() => expect(queryClient.isMutating()).toBe(0))
    expect({
      sent: update.mock.calls.map((call) => call[1].userStatusPresets?.map((preset) => preset.id)),
      shown: screen.getAllByRole("button", { name: /^Remove / }).map((button) => button.getAttribute("aria-label")),
    }).toEqual({
      sent: [[second!.id, ...rest.map((p) => p.id)], rest.map((p) => p.id)],
      shown: rest.map((p) => `Remove ${p.text}`),
    })
  })

  it("moves focus to the next status after a removal, else the previous, else New status", async () => {
    vi.spyOn(workspaceSettingsApi, "update").mockImplementation(async (_ws, input) => input as WorkspaceSettings)
    const user = userEvent.setup()
    const [first, second] = SYSTEM_DEFAULT_STATUSES
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: { userStatusPresets: [first!, second!] },
    })

    await user.click(screen.getByRole("button", { name: `Remove ${first!.text}` }))
    await waitFor(() => expect(screen.queryByRole("button", { name: `Remove ${first!.text}` })).toBeNull())
    const afterFirst = document.activeElement?.getAttribute("aria-label")
    await user.click(screen.getByRole("button", { name: `Remove ${second!.text}` }))
    await waitFor(() => expect(screen.queryByRole("button", { name: `Remove ${second!.text}` })).toBeNull())

    expect({ afterFirst, afterLast: document.activeElement?.textContent }).toEqual({
      afterFirst: `Remove ${second!.text}`,
      afterLast: "New status",
    })
  })

  it("says in words which statuses pause notifications", () => {
    const [first, second] = SYSTEM_DEFAULT_STATUSES
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: {
        userStatusPresets: [
          { ...first!, defaultDuration: null, pausesNotifications: true },
          { ...second!, defaultDuration: null, pausesNotifications: false },
        ],
      },
    })

    expect(
      [first!, second!].map((preset) =>
        screen
          .getByRole("button", { name: `Edit ${preset.text}` })
          .closest("li")
          ?.textContent?.includes("Pauses")
      )
    ).toEqual([true, false])
  })

  it("asks before putting back the system defaults", async () => {
    const custom = [{ ...SYSTEM_DEFAULT_STATUSES[0], id: "status_custom", text: "Heads down" }]
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockImplementation(async (_ws, input) => input as WorkspaceSettings)
    const user = userEvent.setup()
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: { userStatusPresets: custom },
    })

    await user.click(screen.getByRole("button", { name: "Reset to defaults" }))
    expect(update).not.toHaveBeenCalled()
    await user.click(await screen.findByRole("button", { name: "Reset" }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { userStatusPresets: SYSTEM_DEFAULT_STATUSES }))
  })

  it("keeps New status in reach at the limit, saying why it adds nothing", async () => {
    const user = userEvent.setup()
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: {
        userStatusPresets: Array.from({ length: MAX_STATUS_PRESETS }, (_, index) => ({
          ...SYSTEM_DEFAULT_STATUSES[0]!,
          id: `status_${index}`,
        })),
      },
    })
    const button = screen.getByRole("button", { name: "New status" })
    await user.click(button)

    expect({
      disabled: button.hasAttribute("disabled"),
      ariaDisabled: button.getAttribute("aria-disabled"),
      dialog: screen.queryByRole("dialog"),
    }).toEqual({ disabled: false, ariaDisabled: "true", dialog: null })
    expect(button).toHaveAccessibleDescription(
      expect.stringContaining(`A workspace holds up to ${MAX_STATUS_PRESETS} statuses. Remove one to add another.`)
    )
  })

  it("shows the presets read-only with the reason to a non-admin", () => {
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, {
      permissions: [],
      settings: { userStatusPresets: SYSTEM_DEFAULT_STATUSES },
    })

    expect({
      reason: screen.queryByText("Only workspace admins can change this.") !== null,
      buttons: screen.queryAllByRole("button"),
      firstPreset: screen.getByText(SYSTEM_DEFAULT_STATUSES[0]!.text ?? "") !== null,
    }).toEqual({ reason: true, buttons: [], firstPreset: true })
  })

  it("links to the personal status setting", () => {
    renderWorkspaceSettings(<StatusesTab workspaceId="ws_1" />, { permissions: [] })

    expect(screen.getByRole("link", { name: settingDef("status").label })).toHaveAttribute(
      "href",
      "/?settings=profile&setting=status"
    )
  })
})
