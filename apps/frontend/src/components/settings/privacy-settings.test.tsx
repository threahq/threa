import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import * as contextsModule from "@/contexts"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as hooksModule from "@/hooks"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { PrivacySettings } from "./privacy-settings"
import { settingDef } from "./settings-registry"

const updatePreference = vi.fn()
const IN_PLACE = { errorShownInPlace: true }

function mount(
  consent: "unset" | "granted" | "denied",
  analytics: object | null = { posthogToken: "tok", posthogHost: "https://eu.example.com" },
  shareDeviceWithAgents?: boolean,
  diagnosticsFlag: "off" | "available" = "off"
) {
  vi.spyOn(hooksModule, "useFeatureFlag").mockReturnValue(diagnosticsFlag as never)
  vi.spyOn(authModule, "useAuth").mockReturnValue({ user: null } as unknown as ReturnType<typeof authModule.useAuth>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([])
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { analyticsConsent: consent, shareDeviceWithAgents },
    updatePreference,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(useWorkspacesModule, "useWorkspaceBootstrap").mockReturnValue({
    data: { analytics },
  } as unknown as ReturnType<typeof useWorkspacesModule.useWorkspaceBootstrap>)
  return render(
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <Routes>
        <Route path="/w/:workspaceId" element={<PrivacySettings />} />
      </Routes>
    </MemoryRouter>
  )
}

describe("PrivacySettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockReset()
    updatePreference.mockResolvedValue(undefined)
  })

  it("shows both collection switches off and locked, with the reason, when the installation has no analytics", () => {
    mount("granted", null)

    const switches = screen.getAllByRole("switch", { name: /crash reports|record my sessions/i })
    expect(
      switches.map((control) => ({
        checked: control.getAttribute("aria-checked"),
        disabled: control.getAttribute("aria-disabled"),
        reason: control.getAttribute("aria-describedby")?.includes("-reason"),
      }))
    ).toEqual([
      { checked: "false", disabled: "true", reason: true },
      { checked: "false", disabled: "true", reason: true },
    ])
    expect(switches[0]).toHaveAccessibleDescription(expect.stringContaining("Turned off for this Threa installation."))
  })

  it("keeps a locked switch in the Tab order with its reason, and ignores pressing it", async () => {
    const user = userEvent.setup()
    mount("denied")

    const recording = screen.getByRole("switch", { name: /record my sessions/i })
    recording.focus()
    await user.keyboard(" ")
    await user.click(recording)

    expect({
      focused: document.activeElement === recording,
      disabled: recording.getAttribute("aria-disabled"),
      checked: recording.getAttribute("aria-checked"),
      writes: updatePreference.mock.calls,
    }).toEqual({ focused: true, disabled: "true", checked: "false", writes: [] })
    expect(recording).toHaveAccessibleDescription(
      expect.stringContaining("Turn on crash reports and usage data first.")
    )
  })

  it("should reflect granted consent as checked", () => {
    mount("granted")
    expect(screen.getByRole("switch", { name: /crash reports and usage data/i })).toBeChecked()
  })

  it("should write denied when switched off", async () => {
    mount("granted")

    await userEvent.click(screen.getByRole("switch", { name: /crash reports and usage data/i }))

    expect(updatePreference).toHaveBeenCalledWith("analyticsConsent", "denied", IN_PLACE)
  })

  it("should write granted when switched on", async () => {
    mount("denied")

    await userEvent.click(screen.getByRole("switch", { name: /crash reports and usage data/i }))

    expect(updatePreference).toHaveBeenCalledWith("analyticsConsent", "granted", IN_PLACE)
  })

  it("shows a failed save under the switch that failed, not in a toast, and clears it on the next try", async () => {
    updatePreference.mockRejectedValueOnce(new Error("nope"))
    const toastError = vi.spyOn(toast, "error")
    mount("unset")
    const crash = screen.getByRole("switch", { name: /crash reports and usage data/i })

    await userEvent.click(crash)
    const alert = screen.getByRole("alert")
    const failed = {
      text: alert.textContent,
      row: alert.closest("[data-setting]")?.getAttribute("data-setting"),
      describesSwitch: crash.getAttribute("aria-describedby")?.split(" ").includes(alert.id),
      toasts: toastError.mock.calls.length,
      inPlace: updatePreference.mock.calls[0]?.[2],
    }
    await userEvent.click(crash)

    expect({ failed, afterRetry: screen.queryByRole("alert") }).toEqual({
      failed: {
        text: "Couldn't save. Try again.",
        row: "crash-reports",
        describesSwitch: true,
        toasts: 0,
        inPlace: IN_PLACE,
      },
      afterRetry: null,
    })
  })

  describe("device sharing", () => {
    const deviceSwitch = () => screen.getByRole("switch", { name: settingDef("device-sharing").label })

    it("should show on when the preference is unset", () => {
      mount("unset")
      expect(deviceSwitch()).toBeChecked()
    })

    it("should show off when the user turned it off", () => {
      mount("unset", undefined, false)
      expect(deviceSwitch()).not.toBeChecked()
    })

    it("should write false when switched off", async () => {
      mount("unset")
      await userEvent.click(deviceSwitch())
      expect(updatePreference).toHaveBeenCalledWith("shareDeviceWithAgents", false, IN_PLACE)
    })

    it("should write true when switched back on", async () => {
      mount("unset", undefined, false)
      await userEvent.click(deviceSwitch())
      expect(updatePreference).toHaveBeenCalledWith("shareDeviceWithAgents", true, IN_PLACE)
    })

    it("should disclose what is shared, what is kept, and that location is not", () => {
      mount("unset")
      expect(deviceSwitch()).toHaveAccessibleDescription(settingDef("device-sharing").description)
    })
  })

  describe("page layout", () => {
    it("renders encryption and every data-sharing row in registry order", () => {
      const { container } = mount("granted", undefined, undefined, "available")
      expect([...container.querySelectorAll("[data-setting]")].map((row) => row.getAttribute("data-setting"))).toEqual([
        "encryption",
        "encryption-keep-unlocked",
        "encryption-unlock-method",
        "crash-reports",
        "session-recording",
        "device-sharing",
        "diagnostics",
      ])
    })

    it("should leave diagnostics out when its rollout flag is off", () => {
      const { container } = mount("granted")
      expect(container.querySelector("#setting-diagnostics")).toBeNull()
    })
  })
})
