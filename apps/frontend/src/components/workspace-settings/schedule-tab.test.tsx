import { afterEach, describe, expect, it, vi } from "vitest"
import { screen, userEvent, waitFor } from "@/test"
import { WORKSPACE_PERMISSION_SCOPES, type WorkspaceSettings } from "@threahq/types"
import { workspaceSettingsApi } from "@/api"
import { settingDef } from "@/components/settings/settings-registry"
import { ScheduleTab } from "./schedule-tab"
import { renderWorkspaceSettings } from "./test-harness"

afterEach(() => vi.restoreAllMocks())

const REASON = "Only workspace admins can change this."

describe("ScheduleTab", () => {
  it("lands on the members' own working hours from its twin link", async () => {
    const user = userEvent.setup()
    renderWorkspaceSettings(<ScheduleTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
    })

    await user.click(screen.getByRole("button", { name: /working hours/i }))
    await user.click(screen.getByRole("link", { name: settingDef("working-hours").label }))

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("setting=working-hours"))
  })

  it("saves each edit straight away, with no Save button", async () => {
    const update = vi
      .spyOn(workspaceSettingsApi, "update")
      .mockImplementation(async (_ws, input) => input as WorkspaceSettings)
    const user = userEvent.setup()
    renderWorkspaceSettings(<ScheduleTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
    })

    await user.click(screen.getByRole("button", { name: /working hours/i }))
    const saturday = screen.getByRole("switch", { name: "Saturday" })
    await user.click(saturday)

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect({
      saturday: update.mock.calls[0][1].defaultWorkSchedule?.days[6]?.length,
      checked: saturday.getAttribute("aria-checked"),
      saveButton: screen.queryByRole("button", { name: /save/i }),
    }).toEqual({ saturday: 1, checked: "true", saveButton: null })
  })

  it("shows the week on one line, with the day-by-day editor behind it", async () => {
    const user = userEvent.setup()
    renderWorkspaceSettings(<ScheduleTab workspaceId="ws_1" />, {
      permissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
    })

    const trigger = screen.getByRole("button", { name: /working hours/i })
    const closed = { line: trigger.textContent, days: screen.queryAllByRole("switch").length }
    await user.click(trigger)

    expect({ closed, open: screen.getAllByRole("switch").length }).toEqual({
      closed: { line: expect.stringMatching(/Mon–Fri 0?9:00/), days: 0 },
      open: 7,
    })
  })

  it("shows the default read-only with the reason to a non-admin", async () => {
    const user = userEvent.setup()
    renderWorkspaceSettings(<ScheduleTab workspaceId="ws_1" />, { permissions: [] })
    await user.click(screen.getByRole("button", { name: /working hours/i }))

    const switches = screen.getAllByRole("switch")
    expect({
      reason: screen.queryByText(REASON) !== null,
      save: screen.queryByRole("button", { name: "Save hours" }),
      editable: switches.some((toggle) => !toggle.hasAttribute("disabled")),
    }).toEqual({ reason: true, save: null, editable: false })
  })

  it("claims no restriction while permissions are still loading", () => {
    renderWorkspaceSettings(<ScheduleTab workspaceId="ws_1" />, { permissions: null })

    expect(screen.queryByText(REASON)).toBeNull()
  })
})
