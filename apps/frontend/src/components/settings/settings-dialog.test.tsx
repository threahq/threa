import { useEffect, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SettingsDialog } from "./settings-dialog"
import * as contextsModule from "@/contexts"
import * as profileSettingsModule from "./profile-settings"
import * as aiSettingsModule from "./ai-settings"
import * as appearanceSettingsModule from "./appearance-settings"
import * as datetimeSettingsModule from "./datetime-settings"
import * as notificationsSettingsModule from "./notifications-settings"
import * as keyboardSettingsModule from "./keyboard-settings"
import * as accessibilitySettingsModule from "./accessibility-settings"
import * as privacySettingsModule from "./privacy-settings"

const useSettingsSpy = vi.fn()

// The dialog resolves `perfDiagnostics` (query cache) and the workspace id
// (route params) to decide whether the Diagnostics tab is offered.
function renderDialog() {
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
let keyboardCaptureActive = false

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useSettingsSpy.mockReset()
    keyboardCaptureActive = false

    vi.spyOn(contextsModule, "useSettings").mockImplementation((() =>
      useSettingsSpy()) as unknown as typeof contextsModule.useSettings)

    vi.spyOn(profileSettingsModule, "ProfileSettings").mockImplementation(() => <div>Profile panel</div>)
    vi.spyOn(aiSettingsModule, "AISettings").mockImplementation(() => <div>AI panel</div>)
    vi.spyOn(appearanceSettingsModule, "AppearanceSettings").mockImplementation(() => <div>Appearance panel</div>)
    vi.spyOn(datetimeSettingsModule, "DateTimeSettings").mockImplementation(() => <div>Date & Time panel</div>)
    vi.spyOn(notificationsSettingsModule, "NotificationsSettings").mockImplementation(() => (
      <div>Notifications panel</div>
    ))
    vi.spyOn(accessibilitySettingsModule, "AccessibilitySettings").mockImplementation(() => (
      <div>Accessibility panel</div>
    ))
    vi.spyOn(privacySettingsModule, "PrivacySettings").mockImplementation(() => <div>Privacy panel</div>)

    vi.spyOn(keyboardSettingsModule, "KeyboardSettings").mockImplementation(((props: {
      onCaptureStateChange?: (isCapturing: boolean) => void
    }) => {
      const { onCaptureStateChange } = props
      useEffect(() => {
        if (!keyboardCaptureActive) {
          return
        }

        onCaptureStateChange?.(true)
        return () => onCaptureStateChange?.(false)
      }, [onCaptureStateChange])

      return <div>Keyboard panel</div>
    }) as unknown as typeof keyboardSettingsModule.KeyboardSettings)
  })

  it("keeps the navigation and active panel in scrollable regions", async () => {
    useSettingsSpy.mockReturnValue({
      isOpen: true,
      activeTab: "profile",
      closeSettings: vi.fn(),
      setActiveTab: vi.fn(),
    })

    renderDialog()

    expect(await screen.findByText("Identity and account details")).toBeInTheDocument()
    expect(screen.getByText("Profile panel")).toBeVisible()

    const tabs = document.body.querySelector('[data-slot="settings-tabs"]')
    const panels = document.body.querySelector('[data-slot="settings-panels"]')
    const nav = document.body.querySelector('[data-slot="settings-nav"]')
    const content = document.body.querySelector('[data-slot="settings-content"]')

    expect(tabs).toHaveClass("flex", "flex-1", "min-h-0", "flex-col")
    expect(panels).toHaveClass("flex", "flex-1", "min-h-0", "overflow-hidden")
    expect(nav).toHaveClass("min-h-0", "overflow-y-auto")
    expect(content).toHaveClass("flex-1", "min-h-0", "overflow-y-auto", "pt-6")
  })

  it("does not close on Escape while shortcut capture is active", async () => {
    const user = userEvent.setup()
    const closeSettings = vi.fn()
    keyboardCaptureActive = true
    useSettingsSpy.mockReturnValue({
      isOpen: true,
      activeTab: "keyboard",
      closeSettings,
      setActiveTab: vi.fn(),
    })

    renderDialog()

    await user.keyboard("{Escape}")

    expect(closeSettings).not.toHaveBeenCalled()
  })
})
