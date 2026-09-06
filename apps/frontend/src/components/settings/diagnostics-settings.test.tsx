import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import type { ReactNode } from "react"
import { DEFAULT_USER_PREFERENCES } from "@threahq/types"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as perfApiModule from "@/api/perf-diagnostics"
import * as profileSettingsModule from "./profile-settings"
import { PerfCapture, armPerfCapture, resetPerfArming, setPerfConsentArmed } from "@/lib/perf/capture"
import { DiagnosticsSettings } from "./diagnostics-settings"
import { SettingsDialog } from "./settings-dialog"

const updatePreference = vi.fn()

function mountSettings(optIn: boolean) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { performanceDiagnosticsOptIn: optIn },
    updatePreference,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  return render(
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <Routes>
        <Route path="/w/:workspaceId" element={<DiagnosticsSettings />} />
      </Routes>
    </MemoryRouter>
  )
}

function mountDialog(flag: "off" | "available") {
  vi.spyOn(hooksModule, "useFeatureFlag").mockReturnValue(flag as never)
  // The dialog opens on Profile, which needs auth/query wiring irrelevant here.
  vi.spyOn(profileSettingsModule, "ProfileSettings").mockImplementation(() => <div>Profile panel</div>)
  vi.spyOn(contextsModule, "useSettings").mockReturnValue({
    isOpen: true,
    activeTab: "profile",
    closeSettings: vi.fn(),
    setActiveTab: vi.fn(),
  } as unknown as ReturnType<typeof contextsModule.useSettings>)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/w/ws_1"]}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<SettingsDialog />, { wrapper: Wrapper })
}

function armWithSamples(count: number): PerfCapture {
  const capture = new PerfCapture()
  for (let i = 0; i < count; i++) capture.mark("liveQuery.rerun", i)
  armPerfCapture(capture)
  setPerfConsentArmed(true)
  return capture
}

describe("DiagnosticsSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockReset()
    updatePreference.mockResolvedValue(undefined)
    armPerfCapture(new PerfCapture())
    resetPerfArming()
  })

  afterEach(() => {
    resetPerfArming()
  })

  it("has the toggle off by default", () => {
    // Mounted with the shipped defaults, not a hand-set false.
    mountSettings(DEFAULT_USER_PREFERENCES.performanceDiagnosticsOptIn)

    expect(screen.getByRole("switch", { name: /share performance diagnostics/i })).not.toBeChecked()
    expect(screen.queryByRole("button", { name: /send diagnostics/i })).not.toBeInTheDocument()
  })

  it("is absent from the settings dialog when the flag is off", async () => {
    mountDialog("off")
    expect(screen.queryByText("Diagnostics")).not.toBeInTheDocument()

    mountDialog("available")
    await waitFor(() => expect(screen.getAllByText("Diagnostics").length).toBeGreaterThan(0))
  })

  it("clears the buffer and persists the opt-out when the toggle goes off", async () => {
    const capture = armWithSamples(3)
    mountSettings(true)

    await userEvent.click(screen.getByRole("switch", { name: /share performance diagnostics/i }))

    expect({
      samples: capture.snapshot().length,
      written: updatePreference.mock.calls,
    }).toEqual({ samples: 0, written: [["performanceDiagnosticsOptIn", false]] })
  })

  it("disables Send with an empty buffer", () => {
    setPerfConsentArmed(true)
    mountSettings(true)

    expect(screen.getByRole("button", { name: /send diagnostics/i })).toBeDisabled()
  })

  it("swaps the button to a checkmark on a successful send and fires no toast", async () => {
    armWithSamples(2)
    const send = vi.spyOn(perfApiModule, "sendPerfCapture").mockResolvedValue({ id: "perfcap_1" })
    const success = vi.spyOn(toast, "success")
    const error = vi.spyOn(toast, "error")
    mountSettings(true)

    await userEvent.click(screen.getByRole("button", { name: /send diagnostics/i }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /send diagnostics/i }).querySelector(".lucide-check")).toBeTruthy()
    )
    expect({
      sends: send.mock.calls.length,
      success: success.mock.calls.length,
      error: error.mock.calls.length,
    }).toEqual({ sends: 1, success: 0, error: 0 })
  })

  it("reports a failed send with an error toast", async () => {
    armWithSamples(2)
    vi.spyOn(perfApiModule, "sendPerfCapture").mockRejectedValue(new Error("nope"))
    const error = vi.spyOn(toast, "error")
    mountSettings(true)

    await userEvent.click(screen.getByRole("button", { name: /send diagnostics/i }))

    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to send diagnostics"))
    expect(error).toHaveBeenCalledTimes(1)
  })
})

describe("DiagnosticsSettings under dev-only arming", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockReset()
    updatePreference.mockResolvedValue(undefined)
    armPerfCapture(new PerfCapture())
    resetPerfArming()
  })

  it("refuses to send when capture is armed for local development only", () => {
    const capture = new PerfCapture()
    capture.mark("liveQuery.rerun", 1)
    armPerfCapture(capture)
    // No consent source — the dev query-param/localStorage switch is not consent.
    mountSettings(true)

    expect(screen.getByRole("button", { name: /send diagnostics/i })).toBeDisabled()
  })
})
