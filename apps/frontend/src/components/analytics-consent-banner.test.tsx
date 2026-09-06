import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import * as contextsModule from "@/contexts"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import { AnalyticsConsentBanner } from "./analytics-consent-banner"

const updatePreference = vi.fn()

function mount(
  consent: "unset" | "granted" | "denied",
  analytics: { posthogToken: string; posthogHost: string } | null
) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { analyticsConsent: consent },
    updatePreference,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(useWorkspacesModule, "useWorkspaceBootstrap").mockReturnValue({
    data: { analytics },
  } as unknown as ReturnType<typeof useWorkspacesModule.useWorkspaceBootstrap>)
  return render(<AnalyticsConsentBanner workspaceId="ws_1" />)
}

describe("AnalyticsConsentBanner", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockReset()
    updatePreference.mockResolvedValue(undefined)
  })

  it("should render nothing when consent is already granted", () => {
    mount("granted", { posthogToken: "phc_1", posthogHost: "https://posthog.example.com" })
    expect(screen.queryByRole("region", { name: /analytics consent/i })).not.toBeInTheDocument()
  })

  it("should render nothing when the workspace has no analytics config", () => {
    mount("unset", null)
    expect(screen.queryByRole("region", { name: /analytics consent/i })).not.toBeInTheDocument()
  })

  it("should store granted when the user allows", async () => {
    mount("unset", { posthogToken: "phc_1", posthogHost: "https://posthog.example.com" })

    await userEvent.click(screen.getByRole("button", { name: /allow/i }))

    expect(updatePreference).toHaveBeenCalledWith("analyticsConsent", "granted")
  })

  it("should store denied when the user declines", async () => {
    mount("unset", { posthogToken: "phc_1", posthogHost: "https://posthog.example.com" })

    await userEvent.click(screen.getByRole("button", { name: /decline/i }))

    expect(updatePreference).toHaveBeenCalledWith("analyticsConsent", "denied")
  })

  it("reports a failed update with an error toast", async () => {
    updatePreference.mockRejectedValue(new Error("nope"))
    const error = vi.spyOn(toast, "error")
    mount("unset", { posthogToken: "phc_1", posthogHost: "https://posthog.example.com" })

    await userEvent.click(screen.getByRole("button", { name: /allow/i }))

    expect(error).toHaveBeenCalledWith("Failed to update the privacy preference")
  })
})
