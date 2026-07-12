import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, userEvent, spyOnExport } from "@/test"
import { SMART_SIDEBAR_CONFIG, ALL_SIDEBAR_CONFIG, QUICK_LINKS_SECTION_ID, type SidebarConfig } from "@threa/types"
import * as sidebarConfigHook from "@/hooks/use-sidebar-config"
import * as workspaceStore from "@/stores/workspace-store"
import * as contexts from "@/contexts"
import * as dialogModule from "@/components/ui/responsive-dialog"
import { SidebarEditorDialog } from "./sidebar-editor"
import { createCustomSection, moveSection, removeSection, renameCustomSection } from "./sidebar-config"

const WORKSPACE_ID = "ws_1"

const setConfig = vi.fn()
const setBasePreset = vi.fn()

/** Drive `useSidebarConfig` to return the given config + capture writes. */
function useConfig(config: SidebarConfig) {
  vi.spyOn(sidebarConfigHook, "useSidebarConfig").mockReturnValue({
    config,
    setConfig,
    setBasePreset,
    isSaving: false,
  })
}

/** Render dialog content inline so the radix portal/open-state doesn't gate assertions. */
function Passthrough({ children }: { children?: React.ReactNode }) {
  return <div>{children}</div>
}

function mount() {
  return render(<SidebarEditorDialog workspaceId={WORKSPACE_ID} open onOpenChange={vi.fn()} />)
}

describe("SidebarEditorDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setConfig.mockClear()
    setBasePreset.mockClear()
    vi.spyOn(workspaceStore, "useWorkspaceLabels").mockReturnValue([])
    vi.spyOn(contexts, "usePreferences").mockReturnValue({
      preferences: null,
    } as unknown as ReturnType<typeof contexts.usePreferences>)

    for (const key of [
      "ResponsiveDialog",
      "ResponsiveDialogContent",
      "ResponsiveDialogHeader",
      "ResponsiveDialogBody",
      "ResponsiveDialogFooter",
      "ResponsiveDialogTitle",
      "ResponsiveDialogDescription",
    ] as const) {
      spyOnExport(dialogModule, key).mockReturnValue(Passthrough as never)
    }
  })

  it("lists the sections in config order, with the quick links nested inside the Quick Links section", () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    const reorderNames = screen.getAllByRole("button", { name: /^Reorder / }).map((b) => b.getAttribute("aria-label"))
    expect(reorderNames).toEqual([
      // The Quick Links section leads the Smart preset; its nested links render
      // inside its row (so they appear in the DOM right after it), then the
      // sibling stream sections follow.
      "Reorder Quick Links",
      "Reorder Drafts",
      "Reorder Saved",
      "Reorder Files",
      "Reorder Scheduled",
      "Reorder Memory",
      "Reorder Labels",
      "Reorder Activity",
      "Reorder Important",
      "Reorder Recent",
      "Reorder Everything Else",
    ])
  })

  it("hides a quick link via its visibility control", async () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    await userEvent.click(screen.getByRole("radio", { name: "Hide Drafts" }))

    expect(setConfig).toHaveBeenCalledWith({
      ...SMART_SIDEBAR_CONFIG,
      quickLinks: SMART_SIDEBAR_CONFIG.quickLinks.map((l) => (l.key === "drafts" ? { ...l, visibility: "hidden" } : l)),
    })
  })

  it("sets a quick link to 'show when active'", async () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    await userEvent.click(screen.getByRole("radio", { name: "Show Drafts when active" }))

    expect(setConfig).toHaveBeenCalledWith({
      ...SMART_SIDEBAR_CONFIG,
      quickLinks: SMART_SIDEBAR_CONFIG.quickLinks.map((l) => (l.key === "drafts" ? { ...l, visibility: "active" } : l)),
    })
  })

  it("offers 'show when active' only for links that carry a signal", () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    // Drafts has a count → the active option exists.
    expect(screen.getByRole("radio", { name: "Show Drafts when active" })).toBeInTheDocument()
    // Files has no signal → no active option, just show/hide.
    expect(screen.queryByRole("radio", { name: "Show Files when active" })).not.toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Show Files" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Hide Files" })).toBeInTheDocument()
  })

  it("removes a section, persisting the config without it", async () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    await userEvent.click(screen.getByRole("button", { name: "Remove Recent" }))

    expect(setConfig).toHaveBeenCalledWith(removeSection(SMART_SIDEBAR_CONFIG, "recent"))
  })

  it("removes the entire Quick Links block", async () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    await userEvent.click(screen.getByRole("button", { name: "Remove Quick Links" }))

    expect(setConfig).toHaveBeenCalledWith(removeSection(SMART_SIDEBAR_CONFIG, QUICK_LINKS_SECTION_ID))
  })

  it("seeds from a preset and highlights the active one", async () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    expect(screen.getByRole("button", { name: "Smart" })).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(screen.getByRole("button", { name: "All" }))
    expect(setBasePreset).toHaveBeenCalledWith("all")
  })

  it("highlights neither preset once the layout is customized", () => {
    // A reordered Smart layout matches no preset.
    useConfig(moveSection(SMART_SIDEBAR_CONFIG, "other", "important"))
    mount()

    expect(screen.getByRole("button", { name: "Smart" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false")
  })

  it("resets a customized layout back to its base preset", async () => {
    // A reordered Smart layout — diverged from the preset, so Reset is enabled.
    useConfig(moveSection(SMART_SIDEBAR_CONFIG, "other", "important"))
    mount()

    await userEvent.click(screen.getByRole("button", { name: "Reset preset" }))

    expect(setBasePreset).toHaveBeenCalledWith("smart")
  })

  it("disables Reset preset when the layout already matches a preset", () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    expect(screen.getByRole("button", { name: "Reset preset" })).toBeDisabled()
  })

  it("adds a section from the Add tray by clicking it", async () => {
    // Start from All so the smart buckets are addable in the tray.
    useConfig(ALL_SIDEBAR_CONFIG)
    mount()

    await userEvent.click(screen.getByRole("button", { name: "Add Important" }))

    expect(setConfig).toHaveBeenCalledWith({
      ...ALL_SIDEBAR_CONFIG,
      sections: [...ALL_SIDEBAR_CONFIG.sections, { id: "important", spec: { kind: "smart", bucket: "important" } }],
    })
  })

  it("creates a custom section from the inline creator", async () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    await userEvent.type(screen.getByRole("textbox", { name: "New custom section name" }), "Work")
    await userEvent.click(screen.getByRole("button", { name: "Add section" }))

    expect(setConfig).toHaveBeenCalledTimes(1)
    const next = setConfig.mock.calls[0][0] as SidebarConfig
    // Appended as an empty custom section (the id is minted at create time).
    expect(next.sections.at(-1)?.spec).toMatchObject({ kind: "custom", name: "Work", streamIds: [] })
    expect(next.sections.slice(0, -1)).toEqual(SMART_SIDEBAR_CONFIG.sections)
  })

  it("renames a custom section on blur", async () => {
    const config = createCustomSection(SMART_SIDEBAR_CONFIG, "sec_1", "Work")
    useConfig(config)
    mount()

    const input = screen.getByRole("textbox", { name: "Section name" })
    await userEvent.clear(input)
    await userEvent.type(input, "Personal")
    await userEvent.tab()

    expect(setConfig).toHaveBeenCalledWith(renameCustomSection(config, "sec_1", "Personal"))
  })
})
