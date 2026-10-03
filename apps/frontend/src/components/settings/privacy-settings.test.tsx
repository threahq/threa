import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { MemoryRouter } from "react-router-dom"
import * as contextsModule from "@/contexts"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import { PrivacySettings } from "./privacy-settings"

const updatePreference = vi.fn()

function mount(
  consent: "unset" | "granted" | "denied",
  analytics: object | null = { posthogToken: "tok", posthogHost: "https://eu.example.com" },
  shareDeviceWithAgents?: boolean
) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { analyticsConsent: consent, shareDeviceWithAgents },
    updatePreference,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(useWorkspacesModule, "useWorkspaceBootstrap").mockReturnValue({
    data: { analytics },
  } as unknown as ReturnType<typeof useWorkspacesModule.useWorkspaceBootstrap>)
  return render(
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <PrivacySettings />
    </MemoryRouter>
  )
}

describe("PrivacySettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockReset()
    updatePreference.mockResolvedValue(undefined)
  })

  it("should disable the switch when analytics is not configured for the workspace", () => {
    mount("granted", null)

    const toggle = screen.getByRole("switch", { name: /send crash reports and usage data/i })
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.getByText("Not configured for this workspace.")).toBeTruthy()
  })

  it("should reflect granted consent as checked", () => {
    mount("granted")
    expect(screen.getByRole("switch", { name: /send crash reports and usage data/i })).toBeChecked()
  })

  it("should write denied when switched off", async () => {
    mount("granted")

    await userEvent.click(screen.getByRole("switch", { name: /send crash reports and usage data/i }))

    expect(updatePreference).toHaveBeenCalledWith("analyticsConsent", "denied")
  })

  it("should write granted when switched on", async () => {
    mount("denied")

    await userEvent.click(screen.getByRole("switch", { name: /send crash reports and usage data/i }))

    expect(updatePreference).toHaveBeenCalledWith("analyticsConsent", "granted")
  })

  it("reports a failed update with an error toast", async () => {
    updatePreference.mockRejectedValue(new Error("nope"))
    const error = vi.spyOn(toast, "error")
    mount("unset")

    await userEvent.click(screen.getByRole("switch", { name: /send crash reports and usage data/i }))

    expect(error).toHaveBeenCalledWith("Failed to update the privacy preference")
  })

  describe("device sharing", () => {
    const deviceSwitch = () => screen.getByRole("switch", { name: /tell agents which device i'm on/i })

    it("is on until the user turns it off", () => {
      mount("unset")
      expect(deviceSwitch()).toBeChecked()
    })

    it("reflects an explicit off", () => {
      mount("unset", undefined, false)
      expect(deviceSwitch()).not.toBeChecked()
    })

    it("writes false when switched off", async () => {
      mount("unset")
      await userEvent.click(deviceSwitch())
      expect(updatePreference).toHaveBeenCalledWith("shareDeviceWithAgents", false)
    })

    it("writes true when switched back on", async () => {
      mount("unset", undefined, false)
      await userEvent.click(deviceSwitch())
      expect(updatePreference).toHaveBeenCalledWith("shareDeviceWithAgents", true)
    })

    it("discloses what is shared", () => {
      mount("unset")
      expect(
        screen.getByText(/mobile or desktop layout, your operating system, and whether Threa is installed/)
      ).toBeTruthy()
    })
  })
})
