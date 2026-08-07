import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { formatKeyBindingText } from "@/lib/keyboard-shortcuts"
import { KeyboardSettings } from "./keyboard-settings"
import * as contextsModule from "@/contexts"

const mockPreferences = {
  keyboardShortcuts: {} as Record<string, string>,
  messageSendMode: "enter" as const,
  mobileInlineAttachments: true,
}

const updatePreference = vi.fn()
const resetKeyboardShortcut = vi.fn()
const resetAllKeyboardShortcuts = vi.fn()

describe("KeyboardSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockReset()
    resetKeyboardShortcut.mockReset()
    resetAllKeyboardShortcuts.mockReset()
    mockPreferences.keyboardShortcuts = {}
    mockPreferences.mobileInlineAttachments = true

    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: mockPreferences,
      updatePreference,
      resetKeyboardShortcut,
      resetAllKeyboardShortcuts,
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  })

  it("updates mobile inline attachment behavior", async () => {
    render(<KeyboardSettings />)

    const toggle = screen.getByRole("switch", { name: "Insert files at the cursor" })
    expect(toggle).toBeChecked()

    await userEvent.click(toggle)

    expect(updatePreference).toHaveBeenCalledWith("mobileInlineAttachments", false)
  })

  it("saves conflict overrides as a single keyboardShortcuts update", async () => {
    const user = userEvent.setup()
    render(<KeyboardSettings />)

    const row = screen.getByText("Toggle Sidebar").closest("[data-shortcut-row]")
    expect(row).not.toBeNull()

    const badge = within(row! as HTMLElement).getByRole("button")
    await user.click(badge)
    fireEvent.keyDown(document, { key: "b", ctrlKey: true })

    expect(screen.getByText("Move shortcut?")).toBeInTheDocument()
    expect(screen.getByText(/is currently used by Bold/i)).toBeInTheDocument()
    expect(screen.getByText("New owner")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Move to Toggle Sidebar" }))

    expect(updatePreference).toHaveBeenCalledTimes(1)
    expect(updatePreference).toHaveBeenCalledWith("keyboardShortcuts", {
      formatBold: "none",
      toggleSidebar: "mod+b",
    })
  })

  it("shows the capture popover before a shortcut is chosen", async () => {
    const user = userEvent.setup()
    render(<KeyboardSettings />)

    const row = screen.getByText("Toggle Sidebar").closest("[data-shortcut-row]")
    expect(row).not.toBeNull()

    const badge = within(row! as HTMLElement).getByRole("button")
    await user.click(badge)

    expect(screen.getByText("Press shortcut keys")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("ignores unsafe bare keys during capture", async () => {
    const user = userEvent.setup()
    render(<KeyboardSettings />)

    const row = screen.getByText("Toggle Sidebar").closest("[data-shortcut-row]")
    expect(row).not.toBeNull()

    const badge = within(row! as HTMLElement).getByRole("button")
    await user.click(badge)
    fireEvent.keyDown(document, { key: "b" })

    expect(updatePreference).not.toHaveBeenCalled()
    expect(screen.queryByText(/Conflicts with/i)).not.toBeInTheDocument()
  })

  it("shows a tooltip for the reset icon button", async () => {
    const user = userEvent.setup()
    mockPreferences.keyboardShortcuts = { toggleSidebar: "mod+b" }
    render(<KeyboardSettings />)

    const resetButton = screen.getByRole("button", { name: "Reset to default" })
    await user.hover(resetButton)

    expect((await screen.findAllByText("Reset to default")).length).toBeGreaterThan(0)
  })

  it("shows the text version of a shortcut on hover", () => {
    render(<KeyboardSettings />)

    const row = screen.getByText("Quick Switcher").closest("[data-shortcut-row]")
    expect(row).not.toBeNull()

    const badge = within(row! as HTMLElement).getByRole("button")
    expect(badge).toHaveAttribute("title", formatKeyBindingText("mod+k"))
  })

  it("does not expose a way to bind Escape — it is reserved for close/cancel flows", async () => {
    const user = userEvent.setup()
    render(<KeyboardSettings />)

    const row = screen.getByText("Toggle Sidebar").closest("[data-shortcut-row]")
    expect(row).not.toBeNull()

    const badge = within(row! as HTMLElement).getByRole("button")
    await user.click(badge)

    expect(screen.queryByRole("button", { name: "Bind Escape" })).toBeNull()
  })

  it("reports capture state changes and cancels capture on Escape", async () => {
    const user = userEvent.setup()
    const onCaptureStateChange = vi.fn()
    render(<KeyboardSettings onCaptureStateChange={onCaptureStateChange} />)

    const row = screen.getByText("Toggle Sidebar").closest("[data-shortcut-row]")
    expect(row).not.toBeNull()

    const badge = within(row! as HTMLElement).getByRole("button")
    await user.click(badge)
    fireEvent.keyDown(document, { key: "Escape" })
    fireEvent.keyDown(document, { key: "b", ctrlKey: true })

    expect(onCaptureStateChange).toHaveBeenCalledWith(true)
    expect(onCaptureStateChange).toHaveBeenCalledWith(false)
    expect(updatePreference).not.toHaveBeenCalled()
  })
})
