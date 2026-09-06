import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Settings } from "lucide-react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CompanionModes, StreamTypes } from "@threahq/types"
import { render, screen, spyOnExport, userEvent } from "@/test"
import { StreamSheet } from "./stream-sheet"
import type { SidebarActionItem } from "@/components/layout/sidebar/sidebar-actions"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"
import * as drawerModule from "@/components/ui/drawer"
import * as hooksModule from "@/hooks"
import * as useStreamsModule from "@/hooks/use-streams"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as activeBotPresenceModule from "@/hooks/use-active-bot-presence"

// The sheet is the mobile home for everything the phone-width topbar can't
// keep inline. The contract under test: the full name and stream type are
// always shown, a scratchpad colocates the agent settings (companion mode)
// with the action list, a non-scratchpad doesn't, and action rows close the
// sheet before running.

function makeStream(overrides: Partial<VirtualStream> = {}): VirtualStream {
  return {
    id: "stream_1",
    workspaceId: "ws_1",
    type: StreamTypes.SCRATCHPAD,
    slug: null,
    displayName: "Big plans",
    companionMode: CompanionModes.ON,
    isDraft: false,
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
    archivedAt: null,
    ...overrides,
  } as VirtualStream
}

const updateCompanionMode = vi.fn()

function arrange({
  stream = makeStream(),
  actions = [],
  onOpenChange = vi.fn(),
}: {
  stream?: VirtualStream
  actions?: SidebarActionItem[]
  onOpenChange?: (open: boolean) => void
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <StreamSheet
        open
        onOpenChange={onOpenChange}
        workspaceId="ws_1"
        streamId={stream.id}
        stream={stream}
        streamName={stream.displayName ?? "Stream"}
        actions={actions}
      />
    </QueryClientProvider>
  )
  return { onOpenChange }
}

describe("StreamSheet", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    updateCompanionMode.mockReset()

    spyOnExport(drawerModule, "Drawer").mockReturnValue((({
      open,
      children,
    }: {
      open: boolean
      children: ReactNode
    }) => (
      <div data-state={open ? "open" : "closed"}>{open ? children : null}</div>
    )) as unknown as typeof drawerModule.Drawer)
    spyOnExport(drawerModule, "DrawerContent").mockReturnValue((({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    )) as unknown as typeof drawerModule.DrawerContent)
    spyOnExport(drawerModule, "DrawerTitle").mockReturnValue((({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    )) as unknown as typeof drawerModule.DrawerTitle)
    spyOnExport(drawerModule, "DrawerDescription").mockReturnValue((({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    )) as unknown as typeof drawerModule.DrawerDescription)

    vi.spyOn(hooksModule, "useResourceLabelAssignments").mockReturnValue({ labels: [] } as unknown as ReturnType<
      typeof hooksModule.useResourceLabelAssignments
    >)
    vi.spyOn(useStreamsModule, "useUpdateCompanionMode").mockReturnValue({
      mutateAsync: updateCompanionMode,
      isPending: false,
    } as unknown as ReturnType<typeof useStreamsModule.useUpdateCompanionMode>)
    vi.spyOn(useStreamsModule, "useUpdateToolPolicy").mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useStreamsModule.useUpdateToolPolicy>)
    vi.spyOn(useWorkspacesModule, "useCurrentWorkspaceUser").mockReturnValue({ id: "usr_1" } as unknown as ReturnType<
      typeof useWorkspacesModule.useCurrentWorkspaceUser
    >)
    vi.spyOn(activeBotPresenceModule, "useActiveBotPresence").mockReturnValue(null)
  })

  it("colocates the full name, type, and companion-mode settings for a scratchpad", async () => {
    arrange()

    expect(screen.getByText("Big plans")).toBeInTheDocument()
    expect(screen.getByText("Scratchpad")).toBeInTheDocument()

    // The agent settings the desktop pill hides behind a popover are inline.
    const quiet = screen.getByRole("radio", { name: "Quiet" })
    expect(screen.getByRole("radio", { name: "Companion" })).toBeChecked()
    await userEvent.click(quiet)
    expect(updateCompanionMode).toHaveBeenCalledWith({ companionMode: CompanionModes.OFF })
  })

  it("shows no agent section for a channel and surfaces the archived state", () => {
    arrange({
      stream: makeStream({
        type: StreamTypes.CHANNEL,
        slug: "general",
        displayName: "#general",
        archivedAt: "2026-07-01T00:00:00Z",
      }),
    })

    expect(screen.getByText("Channel")).toBeInTheDocument()
    expect(screen.getByText("Archived")).toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "Companion" })).not.toBeInTheDocument()
  })

  it("closes the sheet and runs the selected action", async () => {
    const onSelect = vi.fn()
    const { onOpenChange } = arrange({
      actions: [{ id: "stream-settings", label: "Settings", icon: Settings, onSelect }],
    })

    await userEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSelect).toHaveBeenCalled()
  })
})
