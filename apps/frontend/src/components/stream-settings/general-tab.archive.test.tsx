import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ServicesProvider, type StreamService } from "@/contexts"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as descriptionSectionModule from "./description-section"
import { resetWorkspaceStoreCache, seedWorkspaceCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"
import { StreamTypes, Visibilities, type Stream } from "@threahq/types"
import { GeneralTab } from "./general-tab"

const WS = "ws_1"
const CREATOR = "usr_creator"
const ROOT_CREATOR = "usr_root_creator"
const BYSTANDER = "usr_bystander"
const ARCHIVED_AT = "2026-01-01T00:00:00.000Z"

function stream(id: string, overrides: Partial<Stream> = {}): Stream {
  return {
    id,
    workspaceId: WS,
    type: StreamTypes.THREAD,
    displayName: id,
    slug: null,
    description: null,
    visibility: Visibilities.PUBLIC,
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: CREATOR,
    createdAt: ARCHIVED_AT,
    updatedAt: ARCHIVED_AT,
    archivedAt: null,
    ...overrides,
  }
}

function seed(streams: Stream[]) {
  seedWorkspaceCache(WS, {
    workspace: { id: WS, name: "W", slug: "w", createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT, _cachedAt: 0 } as never,
    users: [],
    streams: streams.map((row) => ({ ...row, _cachedAt: 0 })),
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

function renderTab(props: { stream: Stream; rootStream: Stream | null; currentUserId: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ServicesProvider services={{ streams: { update: vi.fn() } as unknown as StreamService }}>
          <GeneralTab
            workspaceId={WS}
            stream={props.stream}
            rootStream={props.rootStream}
            currentUserId={props.currentUserId}
            notificationLevel={null}
          />
        </ServicesProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

const channel = stream("chan", { type: StreamTypes.CHANNEL, slug: "general", createdBy: ROOT_CREATOR })
const threadA = stream("thread_a", { parentStreamId: "chan", rootStreamId: "chan", createdBy: BYSTANDER })
const threadB = stream("thread_b", { parentStreamId: "thread_a", rootStreamId: "chan" })

beforeEach(() => {
  resetWorkspaceStoreCache()
  resetWorkspaceTableRegistry()
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue(CREATOR)
  vi.spyOn(descriptionSectionModule, "DescriptionSection").mockImplementation(() => (
    <div data-testid="description-section" />
  ))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GeneralTab archive section (thread archival)", () => {
  it("lets the effective root's creator archive a thread someone else started", () => {
    seed([channel, threadA, threadB])
    const view = renderTab({ stream: threadB, rootStream: channel, currentUserId: ROOT_CREATOR })
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument()
    view.unmount()
  })

  it("hides the section from a member who created neither the thread nor its root", () => {
    seed([channel, threadA, threadB])
    const view = renderTab({ stream: threadB, rootStream: channel, currentUserId: BYSTANDER })
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Unarchive" })).toBeNull()
    view.unmount()
  })

  it("names and links the archived ancestor sealing the thread", () => {
    const sealingParent = { ...threadA, displayName: "Design review", archivedAt: ARCHIVED_AT }
    seed([channel, sealingParent, threadB])
    const view = renderTab({ stream: threadB, rootStream: channel, currentUserId: CREATOR })
    const note = screen.getByTestId("sealed-by-ancestor")
    expect(note).toHaveTextContent(
      "Sealed by Design review. It stays read-only and out of the sidebar until that is unarchived."
    )
    expect(screen.getByRole("link", { name: "Design review" })).toHaveAttribute("href", `/w/${WS}/s/thread_a`)
    view.unmount()
  })

  it("shows no ancestor note when the chain is live", () => {
    seed([channel, threadA, threadB])
    const view = renderTab({ stream: threadB, rootStream: channel, currentUserId: CREATOR })
    expect(screen.queryByTestId("sealed-by-ancestor")).toBeNull()
    view.unmount()
  })
})
