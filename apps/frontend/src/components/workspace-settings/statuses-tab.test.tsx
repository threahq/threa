import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  WORKSPACE_PERMISSION_SCOPES,
  type StatusPreset,
  type WorkspaceBootstrap,
  type WorkspaceSettings,
} from "@threa/types"
import { workspaceKeys } from "@/hooks/use-workspaces"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import { StatusesTab } from "./statuses-tab"

const PRESET: StatusPreset = {
  id: "status_1",
  emoji: ":wave:",
  text: "Heads down",
  defaultDuration: null,
  pausesNotifications: false,
}

function renderTab() {
  const queryClient = new QueryClient()
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    viewerPermissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN],
    workspaceSettings: { userStatusPresets: [PRESET] } as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)

  return render(
    <QueryClientProvider client={queryClient}>
      <StatusesTab workspaceId="ws_1" />
    </QueryClientProvider>
  )
}

describe("StatusesTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(emojiHooks, "useWorkspaceEmoji").mockReturnValue({
      toEmoji: () => "👋",
      toShortcode: () => "wave",
    } as unknown as ReturnType<typeof emojiHooks.useWorkspaceEmoji>)
  })

  it("wraps each status preset into two usable rows on narrow screens", () => {
    renderTab()

    const textInput = screen.getByPlaceholderText("Status text")
    const preset = textInput.closest('[data-slot="status-preset"]')

    expect(preset).toHaveClass("grid", "grid-cols-[auto_minmax(0,1fr)_auto_auto]", "sm:flex")
    expect(textInput).toHaveClass("col-span-3", "min-w-0", "sm:flex-1")
    expect(screen.getByRole("combobox")).toHaveClass("col-span-2", "w-full", "sm:w-36")
  })
})
