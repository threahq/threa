import { beforeEach, describe, expect, it, vi } from "vitest"
import { settingDef } from "@/components/settings/settings-registry"
import { screen, userEvent, waitFor } from "@/test"
import { WORKSPACE_PERMISSION_SCOPES, type WorkspaceSettings } from "@threahq/types"
import { workspaceSettingsApi } from "@/api"
import { DictationTab } from "./dictation-tab"
import { renderWorkspaceSettings } from "./test-harness"

describe("DictationTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("lets an admin add a shared steering word", async () => {
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockResolvedValue({ voiceSteeringWords: ["Acme"] } as WorkspaceSettings)
    const user = userEvent.setup()

    renderWorkspaceSettings(<DictationTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
      settings: { voiceSteeringWords: [] },
    })
    await user.type(screen.getByLabelText("Add a dictation steering word"), "Acme{Enter}")

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", { voiceSteeringWords: ["Acme"] }))
  })

  it("shows the list read-only with the reason to a non-admin", () => {
    renderWorkspaceSettings(<DictationTab workspaceId="ws_1" />, {
      permissions: [],
      settings: { voiceSteeringWords: ["Shared"] },
    })

    expect({
      word: screen.queryByText("Shared") !== null,
      input: screen.queryByLabelText("Add a dictation steering word"),
      remove: screen.queryByRole("button", { name: "Remove Shared" }),
      reason: screen.queryByText("Only workspace admins can change this.") !== null,
    }).toEqual({ word: true, input: null, remove: null, reason: true })
  })

  it("links to the personal dictation words", () => {
    renderWorkspaceSettings(<DictationTab workspaceId="ws_1" />, { permissions: [], settings: {} })

    expect(screen.getByRole("link", { name: settingDef("steering-words").label })).toHaveAttribute(
      "href",
      "/?settings=voice&setting=steering-words"
    )
  })
})
