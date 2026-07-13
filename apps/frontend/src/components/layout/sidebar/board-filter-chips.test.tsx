import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, useLocation } from "react-router-dom"
import { fireEvent, render, screen } from "@/test"
import * as Contexts from "@/contexts"
import * as WorkspaceStore from "@/stores/workspace-store"
import * as BoardViewsHooks from "@/hooks/use-board-views"
import { BoardFilterChips } from "./board-filter-chips"

const WS = "workspace_1"

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

function stubStores() {
  vi.spyOn(WorkspaceStore, "useWorkspaceStreams").mockReturnValue([
    { id: "stream_1", type: "channel", slug: "design", displayName: "Design" },
  ] as unknown as ReturnType<typeof WorkspaceStore.useWorkspaceStreams>)
  vi.spyOn(WorkspaceStore, "useWorkspaceUsers").mockReturnValue([])
  vi.spyOn(WorkspaceStore, "useWorkspaceDmPeers").mockReturnValue([])
  vi.spyOn(WorkspaceStore, "useWorkspaceLabels").mockReturnValue([
    { id: "label_a", name: "Urgent", color: "#ff0000", emoji: null, archivedAt: null },
  ] as unknown as ReturnType<typeof WorkspaceStore.useWorkspaceLabels>)
  vi.spyOn(Contexts, "usePreferencesOptional").mockReturnValue(null)
}

function mountAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <BoardFilterChips workspaceId={WS} />
    </MemoryRouter>
  )
}

function loc(): string {
  return screen.getByTestId("loc").textContent ?? ""
}

afterEach(() => vi.restoreAllMocks())

describe("BoardFilterChips", () => {
  it("renders a chip per active include/exclude across streams and labels", () => {
    stubStores()
    mountAt(`/w/${WS}/board?in=stream_1&label=label_a`)
    expect(screen.getByText("#design")).toBeInTheDocument()
    expect(screen.getByText("Urgent")).toBeInTheDocument()
  })

  it("removes just that entry when a chip's X is clicked, preserving the other axes", () => {
    stubStores()
    mountAt(`/w/${WS}/board?in=stream_1&label=label_a`)
    fireEvent.click(screen.getByRole("button", { name: "Remove #design from the board scope" }))
    expect(loc()).toBe(`/w/${WS}/board?label=label_a`)
  })

  it("Clear shows everything: every filter param dropped, lens reset to all explicitly", () => {
    stubStores()
    mountAt(`/w/${WS}/board?lens=active&in=stream_1&label=label_a`)
    fireEvent.click(screen.getByRole("link", { name: "Clear" }))
    // Never the bare query-less /board — that's the home-redirect entry alias,
    // and targeting it is the clear-filters bounce this URL scheme prevents.
    expect(loc()).toBe(`/w/${WS}/board?lens=all`)
  })

  it("Save view opens the save-view dialog", () => {
    stubStores()
    vi.spyOn(BoardViewsHooks, "useSaveBoardView").mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof BoardViewsHooks.useSaveBoardView>)
    mountAt(`/w/${WS}/board?in=stream_1`)
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }))
    expect(screen.getByText("Save current view")).toBeInTheDocument()
  })
})
