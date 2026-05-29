import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, userEvent, spyOnExport } from "@/test"
import { SMART_SIDEBAR_CONFIG, ALL_SIDEBAR_CONFIG, type SidebarConfig } from "@threa/types"
import * as sidebarConfigHook from "@/hooks/use-sidebar-config"
import * as workspaceStore from "@/stores/workspace-store"
import * as contexts from "@/contexts"
import * as dialogModule from "@/components/ui/responsive-dialog"
import * as dropdownModule from "@/components/ui/dropdown-menu"
import { SidebarEditorDialog } from "./sidebar-editor"
import { moveSection } from "./sidebar-config"

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

/** Render dialog + dropdown content inline so radix portals/open-state don't gate the assertions. */
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
    for (const key of ["DropdownMenu", "DropdownMenuContent", "DropdownMenuTrigger"] as const) {
      spyOnExport(dropdownModule, key).mockReturnValue(Passthrough as never)
    }
    spyOnExport(dropdownModule, "DropdownMenuLabel").mockReturnValue(Passthrough as never)
    spyOnExport(dropdownModule, "DropdownMenuSeparator").mockReturnValue((() => null) as never)
    // A dropdown item fires onSelect on click; model it as a button so we can drive it.
    spyOnExport(dropdownModule, "DropdownMenuItem").mockReturnValue((({
      children,
      onSelect,
    }: {
      children?: React.ReactNode
      onSelect?: () => void
    }) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    )) as never)
  })

  it("lists quick links then sections, each in config order", () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    const reorderNames = screen.getAllByRole("button", { name: /^Reorder / }).map((b) => b.getAttribute("aria-label"))
    expect(reorderNames).toEqual([
      // Quick links, default order.
      "Reorder Drafts",
      "Reorder Saved",
      "Reorder Files",
      "Reorder Scheduled",
      "Reorder Memory",
      "Reorder Labels",
      "Reorder Activity",
      // Then the Smart sections.
      "Reorder Important",
      "Reorder Recent",
      "Reorder Pinned",
      "Reorder Everything Else",
    ])
  })

  it("hides a quick link via its visibility switch", async () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    await userEvent.click(screen.getByRole("switch", { name: "Show Drafts" }))

    expect(setConfig).toHaveBeenCalledWith({
      ...SMART_SIDEBAR_CONFIG,
      quickLinks: SMART_SIDEBAR_CONFIG.quickLinks.map((l) => (l.key === "drafts" ? { ...l, enabled: false } : l)),
    })
  })

  it("removes a section, persisting the config without it", async () => {
    useConfig(SMART_SIDEBAR_CONFIG)
    mount()

    await userEvent.click(screen.getByRole("button", { name: "Remove Recent" }))

    expect(setConfig).toHaveBeenCalledWith({
      ...SMART_SIDEBAR_CONFIG,
      sections: SMART_SIDEBAR_CONFIG.sections.filter((s) => s.id !== "recent"),
    })
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
    useConfig(moveSection(SMART_SIDEBAR_CONFIG, "pinned", "important"))
    mount()

    expect(screen.getByRole("button", { name: "Smart" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false")
  })

  it("adds a section that isn't already present", async () => {
    // Start from All so the smart buckets are addable.
    useConfig(ALL_SIDEBAR_CONFIG)
    mount()

    await userEvent.click(screen.getByRole("button", { name: /Important/ }))

    expect(setConfig).toHaveBeenCalledWith({
      ...ALL_SIDEBAR_CONFIG,
      sections: [...ALL_SIDEBAR_CONFIG.sections, { id: "important", spec: { kind: "smart", bucket: "important" } }],
    })
  })
})
