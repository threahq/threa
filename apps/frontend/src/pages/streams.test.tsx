import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { StreamDirectoryStats, StreamWithPreview } from "@threahq/types"
import { render, screen, within } from "@/test"
import * as contextsModule from "@/contexts"
import { SidebarProvider } from "@/contexts"
import * as hooksModule from "@/hooks"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { StreamsPage } from "./streams"

const WS = "ws_1"

function channel(
  id: string,
  slug: string,
  lastAt: string,
  overrides: Partial<StreamWithPreview> = {}
): StreamWithPreview {
  return {
    id,
    workspaceId: WS,
    type: "channel",
    displayName: null,
    slug,
    description: null,
    visibility: "public",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_me",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: lastAt,
    archivedAt: null,
    lastMessagePreview: {
      authorId: "usr_ana",
      authorType: "user",
      content: `**Latest** in ${slug}`,
      createdAt: lastAt,
    },
    ...overrides,
  } as StreamWithPreview
}

function stats(streamId: string, memberCount: number, activity: number[]): StreamDirectoryStats {
  return { streamId, memberCount, recentMemberIds: ["usr_ana"], activity }
}

const STREAMS = [
  channel("stream_general", "general", "2026-09-23T09:00:00.000Z"),
  channel("stream_design", "design", "2026-09-22T09:00:00.000Z"),
  channel("stream_random", "random", "2026-09-20T09:00:00.000Z"),
]

const STATS = [
  stats("stream_general", 2, [1, 0, 0]),
  stats("stream_design", 9, [0, 4, 3]),
  stats("stream_random", 5, [0, 0, 0]),
]

function setup(path: string) {
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
    STREAMS as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamIndex").mockReturnValue(
    new Map() as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamIndex>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue([
    { streamId: "stream_general", joinedAt: "2026-09-02T10:00:00.000Z" },
  ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamMemberships>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
    { id: "usr_ana", workspaceId: WS, name: "Ana", slug: "ana", avatarUrl: null },
  ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([])
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue({
    unreadCounts: { stream_general: 3 },
  } as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUnreadState>)
  vi.spyOn(contextsModule, "useStreamService").mockReturnValue({
    directoryStats: vi.fn(async () => STATS),
    list: vi.fn(async () => []),
  } as unknown as ReturnType<typeof contextsModule.useStreamService>)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: null,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(hooksModule, "useJoinStream").mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof hooksModule.useJoinStream>)

  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SidebarProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/w/:workspaceId/streams/:tab?" element={<StreamsPage />} />
          </Routes>
        </MemoryRouter>
      </SidebarProvider>
    </QueryClientProvider>
  )
}

function listedNames(): string[] {
  const list = screen.getAllByRole("list").at(-1)!
  return within(list)
    .getAllByRole("listitem")
    .map((item) => within(item).getAllByRole("link")[0].textContent ?? "")
    .map((text) => text.match(/#[a-z]+/)?.[0] ?? "")
}

describe("StreamsPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("should show members, activity, preview and join date on each row", async () => {
    setup(`/w/${WS}/streams`)

    const general = (await screen.findAllByRole("link", { name: /#general/ })).at(-1)!
    expect(await within(general).findByLabelText("2 members")).toBeInTheDocument()
    expect(within(general).getByText("Ana: Latest in general")).toBeInTheDocument()
    expect(within(general).getByText(/Joined/)).toBeInTheDocument()
    expect(within(general).getByRole("img", { name: "1 message in the last 3 days" })).toBeInTheDocument()
  })

  it("should put the busiest streams in the most active strip and skip idle ones", async () => {
    setup(`/w/${WS}/streams`)

    const strip = await screen.findByRole("region", { name: "Most active" })
    expect(
      within(strip)
        .getAllByRole("link")
        .map((link) => link.textContent?.match(/#[a-z]+/)?.[0])
    ).toEqual(["#design", "#general"])
  })

  it("should order rows by member count when the URL asks for it", async () => {
    setup(`/w/${WS}/streams?sort=members`)

    await screen.findAllByLabelText("9 members")
    expect(listedNames()).toEqual(["#design", "#random", "#general"])
  })

  it("should list only streams the viewer has not joined when filtered", async () => {
    setup(`/w/${WS}/streams?show=not-joined`)

    await screen.findAllByLabelText("9 members")
    expect(listedNames()).toEqual(["#design", "#random"])
    expect(screen.getByRole("link", { name: "Not joined" })).toHaveAttribute("aria-pressed", "true")
  })
})
