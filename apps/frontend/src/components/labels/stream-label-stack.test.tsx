import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { LabelableResourceTypes, Visibilities } from "@threa/types"
import { spyOnExport } from "@/test"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useMobileModule from "@/hooks/use-mobile"
import * as drawerModule from "@/components/ui/drawer"
import { StreamLabelStack } from "./stream-label-stack"
import type { CachedLabel, CachedLabelAssignment } from "@/hooks"

const WORKSPACE_ID = "ws_1"
const STREAM_ID = "stream_1"
const NOW = "2026-05-29T12:00:00.000Z"

function label(id: string): CachedLabel {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    visibility: Visibilities.PUBLIC,
    creatorUserId: "user_me",
    name: id,
    slug: id,
    color: "#3366ff",
    emoji: null,
    description: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    _cachedAt: Date.now(),
  }
}

function assignment(labelId: string): CachedLabelAssignment {
  return {
    id: `${WORKSPACE_ID}:${LabelableResourceTypes.STREAM}:${STREAM_ID}:${labelId}:user_me`,
    workspaceId: WORKSPACE_ID,
    labelId,
    resourceType: LabelableResourceTypes.STREAM,
    resourceId: STREAM_ID,
    userId: "user_me",
    assignedAt: NOW,
    _cachedAt: Date.now(),
  }
}

/** Drive the underlying store hooks so `useResourceLabelAssignments` resolves to `ids`. */
function setLabels(ids: string[]) {
  vi.spyOn(workspaceStoreModule, "useWorkspaceLabels").mockReturnValue(
    ids.map(label) as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceLabels>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceLabelAssignments").mockReturnValue(
    ids.map(assignment) as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceLabelAssignments>
  )
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StreamLabelStack workspaceId={WORKSPACE_ID} streamId={STREAM_ID} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("StreamLabelStack", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    vi.spyOn(authModule, "useAuth").mockReturnValue({
      user: { id: "workos_me" },
    } as unknown as ReturnType<typeof authModule.useAuth>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
    )
  })

  it("renders nothing when the stream has no labels", () => {
    setLabels([])
    const { container } = mount()
    expect(container).toBeEmptyDOMElement()
  })

  it("caps the collapsed marks and shows a +N overflow with a count + names in the a11y name", () => {
    setLabels(["a", "b", "c", "d", "e"])
    mount()
    // Names are in the accessible name so keyboard/SR users get the full set.
    const trigger = screen.getByRole("button", { name: "5 labels: a, b, c, d, e" })
    // 3 shown + "+2" overflow.
    expect(trigger).toHaveTextContent("+2")
  })

  it("shows no overflow and a singular name at or below the cap", () => {
    setLabels(["only"])
    mount()
    const trigger = screen.getByRole("button", { name: "1 label: only" })
    expect(trigger).not.toHaveTextContent("+")
  })

  it("renders every label as a name-pill in the mobile fan-out", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    // Passthrough the vaul Drawer primitives — jsdom can't drive vaul's
    // open animation, so render the content inline to assert the revealed set.
    const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
    spyOnExport(drawerModule, "Drawer").mockReturnValue(Passthrough as never)
    spyOnExport(drawerModule, "DrawerTrigger").mockReturnValue(Passthrough as never)
    spyOnExport(drawerModule, "DrawerContent").mockReturnValue(Passthrough as never)
    spyOnExport(drawerModule, "DrawerHeader").mockReturnValue(Passthrough as never)
    spyOnExport(drawerModule, "DrawerTitle").mockReturnValue(Passthrough as never)

    setLabels(["alpha", "beta", "gamma", "delta"])
    mount()

    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it("links each fanned-out chip to the label's landing page", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
    spyOnExport(drawerModule, "Drawer").mockReturnValue(Passthrough as never)
    spyOnExport(drawerModule, "DrawerTrigger").mockReturnValue(Passthrough as never)
    spyOnExport(drawerModule, "DrawerContent").mockReturnValue(Passthrough as never)
    spyOnExport(drawerModule, "DrawerHeader").mockReturnValue(Passthrough as never)
    spyOnExport(drawerModule, "DrawerTitle").mockReturnValue(Passthrough as never)

    setLabels(["alpha", "beta"])
    mount()

    const links = screen
      .getAllByRole("link")
      .map((link) => ({ name: link.textContent, href: link.getAttribute("href") }))
    expect(links).toEqual([
      { name: "alpha", href: `/w/${WORKSPACE_ID}/labels/alpha` },
      { name: "beta", href: `/w/${WORKSPACE_ID}/labels/beta` },
    ])
  })
})
