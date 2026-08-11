import type { ReactElement } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { render, screen, within } from "@/test"
import * as hooksModule from "@/hooks"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as countsModule from "@/hooks/use-activity-counts"
import * as workspaceStore from "@/stores/workspace-store"
import { resetActivitySectionLatch } from "@/hooks/use-activity-sections"
import { SidebarProvider, PreferencesProvider } from "@/contexts"
import { ActivityPage } from "./activity"
import type { Activity } from "@threa/types"

const WS = "ws_1"

function activity(id: string, overrides: Partial<Activity> = {}): Activity {
  return {
    id,
    workspaceId: WS,
    userId: "usr_me",
    activityType: "message",
    streamId: "stream_1",
    messageId: `msg_${id}`,
    actorId: "usr_other",
    actorType: "user",
    context: { contentPreview: `preview ${id}`, streamName: "general" },
    readAt: null,
    createdAt: "2026-08-11T10:00:00.000Z",
    isSelf: false,
    emoji: null,
    ...overrides,
  }
}

const READ_AT = "2026-08-11T09:00:00.000Z"

function mockFeed(activities: Activity[]) {
  vi.spyOn(hooksModule, "useActivityFeed").mockReturnValue({
    data: activities,
    isLoading: false,
  } as unknown as ReturnType<typeof hooksModule.useActivityFeed>)
}

function page(client: QueryClient): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <PreferencesProvider workspaceId={WS}>
        <SidebarProvider>
          <MemoryRouter initialEntries={[`/w/${WS}/activity`]}>
            <Routes>
              <Route path="/w/:workspaceId/activity/:filter?" element={<ActivityPage />} />
            </Routes>
          </MemoryRouter>
        </SidebarProvider>
      </PreferencesProvider>
    </QueryClientProvider>
  )
}

/** Row text inside a named section, in DOM order. Scoped by the section's
 *  accessible name so the same-named filter tab can't be mistaken for it. */
function sectionRows(label: string): string[] {
  return within(screen.getByRole("region", { name: label }))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "")
}

describe("ActivityPage sections", () => {
  beforeEach(() => {
    resetActivitySectionLatch()
    vi.spyOn(hooksModule, "useMarkActivityRead").mockReturnValue({ mutate: vi.fn() } as unknown as ReturnType<
      typeof hooksModule.useMarkActivityRead
    >)
    vi.spyOn(hooksModule, "useMarkAllActivityRead").mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof hooksModule.useMarkAllActivityRead>)
    vi.spyOn(hooksModule, "useActors").mockReturnValue({
      getActorName: (id: string) => `actor ${id}`,
      getActorAvatar: () => ({ fallback: "A" }),
    } as unknown as ReturnType<typeof hooksModule.useActors>)
    vi.spyOn(emojiModule, "useWorkspaceEmoji").mockReturnValue({
      toEmoji: (shortcode: string) => (shortcode === "heart" ? "❤️" : null),
    } as unknown as ReturnType<typeof emojiModule.useWorkspaceEmoji>)
    vi.spyOn(countsModule, "useActivityCounts").mockReturnValue({ unreadActivityCount: 0 } as unknown as ReturnType<
      typeof countsModule.useActivityCounts
    >)
    vi.spyOn(workspaceStore, "useWorkspaceStreams").mockReturnValue([])
  })

  afterEach(() => vi.restoreAllMocks())

  it("stacks unread above read, counting what is still unread", () => {
    mockFeed([activity("a"), activity("b", { readAt: READ_AT }), activity("c")])
    render(page(new QueryClient()))

    expect(sectionRows("Unread").join("|")).toContain("preview a")
    expect(sectionRows("Unread").join("|")).toContain("preview c")
    expect(sectionRows("Earlier").join("|")).toContain("preview b")
    expect(within(screen.getByRole("region", { name: "Unread" })).getByText("2")).toBeInTheDocument()
  })

  it("keeps a row in the unread section after it is read, in its original slot", () => {
    const client = new QueryClient()
    mockFeed([activity("a"), activity("b")])
    const { rerender } = render(page(client))
    expect(sectionRows("Unread")).toHaveLength(2)

    mockFeed([activity("a", { readAt: "2026-08-11T10:30:00.000Z" }), activity("b")])
    rerender(page(client))

    const rows = sectionRows("Unread")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain("preview a")
    expect(screen.queryByRole("region", { name: "Earlier" })).not.toBeInTheDocument()
    expect(within(screen.getByRole("region", { name: "Unread" })).getByText("1")).toBeInTheDocument()
  })

  it("shows a reaction's own emoji, resolving the shortcode the wire may carry", () => {
    mockFeed([activity("r", { activityType: "reaction", emoji: ":heart:" })])
    render(page(new QueryClient()))

    const row = within(screen.getByRole("region", { name: "Unread" })).getByRole("link")
    expect(row.textContent).toContain("❤️")
    expect(row.textContent).not.toContain(":heart:")
  })

  it("renders one flat list when nothing is unread", () => {
    mockFeed([activity("a", { readAt: READ_AT })])
    render(page(new QueryClient()))

    expect(screen.queryByRole("region", { name: "Unread" })).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Earlier" })).not.toBeInTheDocument()
    expect(screen.getByText("preview a")).toBeInTheDocument()
  })
})
