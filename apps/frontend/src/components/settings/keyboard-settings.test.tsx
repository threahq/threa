import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { defaultKeyOf, formatActionBinding, formatKeyBindingText, getShortcutAction } from "@/lib/keyboard-shortcuts"
import { KeyboardSettings } from "./keyboard-settings"
import * as contextsModule from "@/contexts"
import * as mobileModule from "@/hooks/use-mobile"
import { renderWorkspaceSettings } from "@/components/workspace-settings/test-harness"

const updatePreference = vi.fn()
const updateAccessibility = vi.fn()
const resetKeyboardShortcut = vi.fn()
const resetAllKeyboardShortcuts = vi.fn()

function mount(preferences: Record<string, unknown> = {}, onCaptureStateChange?: (capturing: boolean) => void) {
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: {
      keyboardShortcuts: {},
      messageSendMode: "enter",
      mobileInlineAttachments: true,
      accessibility: { composerActionSide: "right" },
      ...preferences,
    },
    updatePreference,
    updateAccessibility,
    resetKeyboardShortcut,
    resetAllKeyboardShortcuts,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  return render(<KeyboardSettings onCaptureStateChange={onCaptureStateChange} />)
}

function shortcutButton(label: string) {
  return screen.getByRole("button", { name: new RegExp(`^Change shortcut for ${label}[,.]`) })
}

const toggleSidebarName = `Change shortcut for Toggle sidebar, currently ${formatActionBinding("toggleSidebar", "mod+§")}`

describe("KeyboardSettings", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updatePreference.mockReset()
    updateAccessibility.mockReset()
    resetKeyboardShortcut.mockReset()
    resetAllKeyboardShortcuts.mockReset()
  })

  it("writes the Enter key, send side and file insertion choices", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(screen.getByRole("radio", { name: "Start a new line" }))
    await user.click(screen.getByRole("radio", { name: "Left" }))
    await user.click(screen.getByRole("switch", { name: "Insert files at the cursor" }))

    expect(updatePreference.mock.calls).toEqual([
      ["messageSendMode", "cmdEnter"],
      ["mobileInlineAttachments", false],
    ])
    expect(updateAccessibility).toHaveBeenCalledWith({ composerActionSide: "left" })
  })

  it("shows the default send side when a cached preferences blob predates the field", () => {
    mount({ accessibility: { reducedMotion: false, highContrast: false, fontSize: "medium", fontFamily: "system" } })

    expect(screen.getByRole("radio", { name: "Right" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Left" })).not.toBeChecked()
  })

  it("anchors every shortcut row and names its button by action and keys", () => {
    const { container } = mount()

    expect(container.querySelector("#setting-shortcut-formatBold")).not.toBeNull()
    expect(container.querySelector("#setting-send-side")).not.toBeNull()
    const button = screen.getByRole("button", { name: toggleSidebarName })
    expect(button).toHaveAttribute("title", formatKeyBindingText("mod+§"))
  })

  it("lays each shortcut out as a standard row, its keys filling the row's control column", () => {
    mount({ keyboardShortcuts: { formatBold: "mod+shift+b" } })
    const row = (actionId: string) => document.getElementById(`setting-shortcut-${actionId}`)!
    const keys = shortcutButton("Bold")
    const column = keys.closest("[data-setting-control]")

    expect({
      landing: row("formatBold").getAttribute("data-setting"),
      inColumn: column !== null && row("formatBold").contains(column),
      resetInColumn: column?.contains(screen.getByRole("button", { name: "Reset Bold to default" })),
      defaultInColumn: shortcutButton("Italic").closest("[data-setting-control]") !== null,
    }).toEqual({ landing: "shortcut-formatBold", inColumn: true, resetInColumn: true, defaultInColumn: true })
  })

  it("saves a captured shortcut, announces it and keeps focus on the row's button", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(shortcutButton("Toggle sidebar"))
    expect(screen.getByRole("status")).toHaveTextContent("Press the new keys for Toggle sidebar")
    expect(screen.getByText("Press the new keys. Esc cancels.")).toBeInTheDocument()

    let persist: () => void = () => undefined
    updatePreference.mockReturnValueOnce(new Promise<void>((resolve) => (persist = resolve)))
    fireEvent.keyDown(document, { key: "y", ctrlKey: true })
    const beforePersisted = screen.getByRole("status").textContent
    persist()

    expect(updatePreference).toHaveBeenCalledWith("keyboardShortcuts", { toggleSidebar: "mod+y" })
    expect(beforePersisted).not.toContain("is now")
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        `Toggle sidebar is now ${formatActionBinding("toggleSidebar", "mod+y")}.`
      )
    )
    expect(shortcutButton("Toggle sidebar")).toHaveFocus()
  })

  it("announces a shortcut that failed to save as unchanged", async () => {
    const user = userEvent.setup()
    mount()
    updatePreference.mockRejectedValueOnce(new Error("offline"))

    await user.click(shortcutButton("Toggle sidebar"))
    fireEvent.keyDown(document, { key: "y", ctrlKey: true })

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Couldn't change Toggle sidebar. Its shortcut is unchanged.")
    )
  })

  it("cancels capture on Escape without letting the key reach the settings window", async () => {
    const user = userEvent.setup()
    const onCaptureStateChange = vi.fn()
    const outerListener = vi.fn()
    document.addEventListener("keydown", outerListener)
    mount({}, onCaptureStateChange)

    await user.click(shortcutButton("Toggle sidebar"))
    expect(onCaptureStateChange).toHaveBeenLastCalledWith(true)
    fireEvent.keyDown(document.body, { key: "Escape" })
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true })
    document.removeEventListener("keydown", outerListener)

    expect(outerListener.mock.calls.map(([event]) => (event as KeyboardEvent).key)).toEqual(["b"])
    expect(onCaptureStateChange).toHaveBeenLastCalledWith(false)
    expect(updatePreference).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: toggleSidebarName })).toHaveFocus()
  })

  it("cancels capture when Tab moves focus away", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(shortcutButton("Toggle sidebar"))
    await user.tab()
    fireEvent.keyDown(document, { key: "y", ctrlKey: true })

    expect(updatePreference).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: toggleSidebarName })).not.toHaveFocus()
  })

  it("explains bare keys instead of saving them", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(shortcutButton("Toggle sidebar"))
    fireEvent.keyDown(document, { key: "b" })

    expect(updatePreference).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent("Hold Ctrl or Alt with the key.")
  })

  it("resolves a conflict from the keyboard alone and returns focus to the row", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(shortcutButton("Toggle sidebar"))
    fireEvent.keyDown(document, { key: "b", ctrlKey: true })

    const conflict = `${formatActionBinding("formatBold", "mod+b")} is already used by Bold.`
    expect(screen.getByRole("status")).toHaveTextContent(conflict)
    expect(screen.getByRole("group", { name: /is already used by Bold/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Move to Toggle sidebar" })).toHaveFocus()

    await user.keyboard("{Shift>}{Tab}{/Shift}")
    expect(screen.getByRole("button", { name: "Keep for Bold" })).toHaveFocus()
    await user.keyboard("{Tab}{Enter}")

    expect(updatePreference).toHaveBeenCalledTimes(1)
    expect(updatePreference).toHaveBeenCalledWith("keyboardShortcuts", { formatBold: "none", toggleSidebar: "mod+b" })
    expect(shortcutButton("Toggle sidebar")).toHaveFocus()
  })

  it("keeps the current owner on Escape during a conflict", async () => {
    const user = userEvent.setup()
    const onCaptureStateChange = vi.fn()
    mount({}, onCaptureStateChange)

    await user.click(shortcutButton("Toggle sidebar"))
    fireEvent.keyDown(document, { key: "b", ctrlKey: true })
    expect(onCaptureStateChange).toHaveBeenLastCalledWith(true)
    await user.keyboard("{Escape}")

    expect(screen.queryByRole("button", { name: "Move to Toggle sidebar" })).toBeNull()
    expect(onCaptureStateChange).toHaveBeenLastCalledWith(false)
    expect(updatePreference).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: toggleSidebarName })).toHaveFocus()
  })

  it("marks shortcuts that share keys in text", () => {
    mount({ keyboardShortcuts: { toggleSidebar: "mod+b" } })

    expect(screen.getByText("Same keys as Bold")).toBeInTheDocument()
    expect(screen.getByText("Same keys as Toggle sidebar")).toBeInTheDocument()
  })

  it("resets one shortcut by name, or all of them", async () => {
    const user = userEvent.setup()
    mount({ keyboardShortcuts: { toggleSidebar: "mod+y" } })

    await user.click(screen.getByRole("button", { name: "Reset Toggle sidebar to default" }))
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }))

    expect(resetKeyboardShortcut).toHaveBeenCalledWith("toggleSidebar")
    expect(resetAllKeyboardShortcuts).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("All shortcuts reset to their defaults."))
  })

  it("filters shortcuts by name or keys, and down to the changed ones", async () => {
    const user = userEvent.setup()
    mount({ keyboardShortcuts: { toggleSidebar: "mod+y" } })
    const filter = screen.getByRole("searchbox", { name: "Filter shortcuts" })

    await user.type(filter, "sidebar")
    const byName = screen.queryByRole("button", { name: /^Change shortcut for Bold,/ })
    const sidebarShown = screen.getByRole("button", { name: /^Change shortcut for Toggle sidebar,/ }) !== null
    await user.clear(filter)
    await user.type(filter, "zzzz")
    const empty = screen.getByText("No shortcuts match.") !== null
    await user.clear(filter)
    await user.click(screen.getByRole("button", { name: "Changed (1)" }))

    expect({
      byName,
      sidebarShown,
      empty,
      changedOnly: screen
        .getAllByRole("button", { name: /^Change shortcut for / })
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    }).toEqual({
      byName: null,
      sidebarShown: true,
      empty: true,
      changedOnly: [expect.stringMatching(/^Change shortcut for Toggle sidebar,/)],
    })
  })

  it("badges each changed shortcut, and offers Reset to defaults only while one is changed", () => {
    const bold = getShortcutAction("formatBold")!
    const { container, unmount } = mount({
      keyboardShortcuts: { toggleSidebar: "mod+y", formatBold: defaultKeyOf(bold) },
    })
    const badged = (id: string) =>
      within(container.querySelector<HTMLElement>(`#setting-shortcut-${id}`)!).queryByText("Changed from default") !==
      null
    const changed = { toggleSidebar: badged("toggleSidebar"), formatBold: badged("formatBold") }
    const resetWhileChanged = screen.queryByRole("button", { name: "Reset to defaults" }) !== null
    unmount()
    mount({ keyboardShortcuts: { formatBold: defaultKeyOf(bold) } })

    expect({
      changed,
      resetWhileChanged,
      resetAtDefaults: screen.queryByRole("button", { name: "Reset to defaults" }),
    }).toEqual({
      changed: { toggleSidebar: true, formatBold: false },
      resetWhileChanged: true,
      resetAtDefaults: null,
    })
  })

  it("keeps focus in the Changed list when a reset takes a row out of it", async () => {
    const user = userEvent.setup()
    let bindings: Record<string, string> = { toggleSidebar: "mod+y", formatBold: "mod+shift+y" }
    vi.spyOn(contextsModule, "usePreferences").mockImplementation(
      () =>
        ({
          preferences: { keyboardShortcuts: bindings, accessibility: {} },
          updatePreference,
          updateAccessibility,
          resetKeyboardShortcut,
          resetAllKeyboardShortcuts,
        }) as unknown as ReturnType<typeof contextsModule.usePreferences>
    )
    const { rerender } = render(<KeyboardSettings />)
    resetKeyboardShortcut.mockImplementation((id: string) => {
      bindings = Object.fromEntries(Object.entries(bindings).filter(([key]) => key !== id))
      rerender(<KeyboardSettings />)
    })

    await user.click(screen.getByRole("button", { name: "Changed (2)" }))
    await user.click(screen.getByRole("button", { name: "Reset Toggle sidebar to default" }))

    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Change shortcut for Bold,/)
  })

  it("reads an unbound shortcut as Not set", () => {
    mount()
    expect(shortcutButton("Inline code")).toHaveTextContent("Not set")
  })

  it("hides the Changed toggle when every shortcut is at its default", () => {
    mount()
    expect(screen.queryByRole("button", { name: /^Changed/ })).toBeNull()
  })

  describe("on a phone or narrow screen", () => {
    function mountTouch(route?: string) {
      vi.spyOn(mobileModule, "useIsMobile").mockReturnValue(true)
      vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
        preferences: { keyboardShortcuts: { toggleSidebar: "mod+y" }, accessibility: {} },
        updatePreference,
        updateAccessibility,
        resetKeyboardShortcut,
        resetAllKeyboardShortcuts,
      } as unknown as ReturnType<typeof contextsModule.usePreferences>)
      renderWorkspaceSettings(<KeyboardSettings />, { permissions: [], route })
    }

    it("lists every shortcut inline, as on desktop, with no row to open first", () => {
      mountTouch()

      expect({
        disclosure: screen.queryByRole("button", { name: /Customize shortcuts/ }),
        shortcut: screen.getByRole("button", { name: /^Change shortcut for Toggle sidebar,/ }) !== null,
      }).toEqual({ disclosure: null, shortcut: true })
    })

    it("lands a link on one shortcut", () => {
      mountTouch("/?settings=keyboard&setting=shortcut-toggleSidebar")

      expect(screen.getByRole("button", { name: /^Change shortcut for Toggle sidebar,/ })).toBeInTheDocument()
    })
  })
})
