import { describe, it, expect, beforeEach, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { LabelableResourceTypes, Visibilities } from "@threa/types"
import { ServicesProvider, type LabelService } from "@/contexts"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useMobileModule from "@/hooks/use-mobile"
import * as connectionStatusModule from "@/components/layout/connection-status"
import { LabelPicker } from "./label-picker"
import type { CachedLabel, CachedLabelAssignment } from "@/hooks"

const WORKSPACE_ID = "ws_1"
const ME = "user_me"
const OTHER = "user_other"
const RESOURCE_ID = "stream_1"
const NOW = "2026-05-28T12:00:00.000Z"

function label(overrides: Partial<CachedLabel> & Pick<CachedLabel, "id" | "name">): CachedLabel {
  return {
    workspaceId: WORKSPACE_ID,
    visibility: Visibilities.PUBLIC,
    creatorUserId: ME,
    slug: overrides.name.toLowerCase(),
    color: "#3366ff",
    emoji: null,
    description: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    _cachedAt: Date.now(),
    ...overrides,
  }
}

function assignment(labelId: string, userId: string): CachedLabelAssignment {
  return {
    id: `${WORKSPACE_ID}:${LabelableResourceTypes.STREAM}:${RESOURCE_ID}:${labelId}:${userId}`,
    workspaceId: WORKSPACE_ID,
    labelId,
    resourceType: LabelableResourceTypes.STREAM,
    resourceId: RESOURCE_ID,
    userId,
    assignedAt: NOW,
    _cachedAt: Date.now(),
  }
}

const assign = vi.fn()
const unassign = vi.fn()

function mountPicker() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const services = { assign, unassign } as unknown as LabelService
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ServicesProvider services={{ labels: services }}>
          <LabelPicker
            workspaceId={WORKSPACE_ID}
            resourceType={LabelableResourceTypes.STREAM}
            resourceId={RESOURCE_ID}
            open
            onOpenChange={() => {}}
          />
        </ServicesProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("LabelPicker", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    assign.mockReset().mockImplementation(async (_ws: string, labelId: string) => assignment(labelId, ME))
    unassign.mockReset().mockResolvedValue(undefined)

    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    vi.spyOn(connectionStatusModule, "useIsOnline").mockReturnValue(true)
    vi.spyOn(authModule, "useAuth").mockReturnValue({
      user: { id: "workos_me" },
    } as unknown as ReturnType<typeof authModule.useAuth>)

    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { id: ME, workosUserId: "workos_me" },
      { id: OTHER, workosUserId: "workos_other" },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceLabelMemberships").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceLabelMemberships>
    )
    // "Mine": a public label I applied. "Shared": a public label only another
    // user applied to this stream — it lives in the shared pool but I have not
    // tagged it myself.
    vi.spyOn(workspaceStoreModule, "useWorkspaceLabels").mockReturnValue([
      label({ id: "label_mine", name: "Mine" }),
      label({ id: "label_shared", name: "Shared" }),
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceLabels>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceLabelAssignments").mockReturnValue([
      assignment("label_mine", ME),
      assignment("label_shared", OTHER),
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceLabelAssignments>)
  })

  it("checks only labels the viewer applied, not every label in the shared pool", () => {
    mountPicker()

    const mine = screen.getByRole("option", { name: /Mine/ })
    const shared = screen.getByRole("option", { name: /Shared/ })

    expect(mine.querySelector(".lucide-check")?.getAttribute("class")).toContain("opacity-100")
    expect(shared.querySelector(".lucide-check")?.getAttribute("class")).toContain("opacity-0")
  })

  it("assigns the viewer's own attribution when toggling a pool label they have not applied", async () => {
    mountPicker()

    fireEvent.click(screen.getByRole("option", { name: /Shared/ }))

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(WORKSPACE_ID, "label_shared", {
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: RESOURCE_ID,
      })
    )
    expect(unassign).not.toHaveBeenCalled()
  })

  it("removes the viewer's attribution when toggling a label they applied", async () => {
    mountPicker()

    fireEvent.click(screen.getByRole("option", { name: /Mine/ }))

    await waitFor(() =>
      expect(unassign).toHaveBeenCalledWith(WORKSPACE_ID, "label_mine", {
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: RESOURCE_ID,
      })
    )
    expect(assign).not.toHaveBeenCalled()
  })
})
