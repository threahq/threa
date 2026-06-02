import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, userEvent, spyOnExport } from "@/test"
import { SMART_SIDEBAR_CONFIG, type SidebarConfig } from "@threa/types"
import * as sidebarConfigHook from "@/hooks/use-sidebar-config"
import * as dialogModule from "@/components/ui/responsive-dialog"
import { SectionPicker } from "./section-picker"
import { createCustomSection, setStreamCustomSection } from "./sidebar-config"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"

const setConfig = vi.fn()

function useConfig(config: SidebarConfig) {
  vi.spyOn(sidebarConfigHook, "useSidebarConfig").mockReturnValue({
    config,
    setConfig,
    setBasePreset: vi.fn(),
    isSaving: false,
  })
}

/** Render dialog content inline so the radix portal/open-state doesn't gate assertions. */
function Passthrough({ children }: { children?: React.ReactNode }) {
  return <div>{children}</div>
}

function withTwoSections(): SidebarConfig {
  return createCustomSection(createCustomSection(SMART_SIDEBAR_CONFIG, "sec_a", "Alpha"), "sec_b", "Beta")
}

function mount() {
  return render(<SectionPicker workspaceId={WORKSPACE_ID} streamId={STREAM_ID} open onOpenChange={vi.fn()} />)
}

describe("SectionPicker", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setConfig.mockClear()
    for (const key of [
      "ResponsiveDialog",
      "ResponsiveDialogContent",
      "ResponsiveDialogHeader",
      "ResponsiveDialogTitle",
      "ResponsiveDialogDescription",
    ] as const) {
      spyOnExport(dialogModule, key).mockReturnValue(Passthrough as never)
    }
  })

  it("files the stream into the picked section (exclusively)", async () => {
    const config = withTwoSections()
    useConfig(config)
    mount()

    await userEvent.click(screen.getByRole("button", { name: /Alpha/ }))

    expect(setConfig).toHaveBeenCalledWith(setStreamCustomSection(config, STREAM_ID, "sec_a"))
  })

  it("removes the stream when the section it's already in is picked again", async () => {
    const config = setStreamCustomSection(withTwoSections(), STREAM_ID, "sec_a")
    useConfig(config)
    mount()

    await userEvent.click(screen.getByRole("button", { name: /Alpha/ }))

    expect(setConfig).toHaveBeenCalledWith(setStreamCustomSection(config, STREAM_ID, null))
  })

  it("creates a section and files the stream into it in one step", async () => {
    const config = withTwoSections()
    useConfig(config)
    mount()

    await userEvent.type(screen.getByRole("textbox", { name: "New section name" }), "Gamma")
    await userEvent.click(screen.getByRole("button", { name: "Add" }))

    expect(setConfig).toHaveBeenCalledTimes(1)
    const next = setConfig.mock.calls[0][0] as SidebarConfig
    const created = next.sections.find((s) => s.spec.kind === "custom" && s.spec.name === "Gamma")
    expect(created?.spec).toMatchObject({ kind: "custom", name: "Gamma", streamIds: [STREAM_ID] })
  })
})
