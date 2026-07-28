import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen } from "@/test"
import * as Contexts from "@/contexts"
import * as WorkspaceStore from "@/stores/workspace-store"
import { setLastLocation } from "@/lib/last-location"
import { BoardLinkRow, ChatsLinkRow } from "./board-link-row"

const WS = "workspace_1"
const USER = "user_1"

function stub() {
  vi.spyOn(Contexts, "useSidebar").mockReturnValue({
    collapseOnMobile: vi.fn(),
  } as unknown as ReturnType<typeof Contexts.useSidebar>)
  vi.spyOn(WorkspaceStore, "useWorkspaceStreams").mockReturnValue([] as never)
}

function hrefOf(name: string): string {
  return screen.getByRole("link", { name }).getAttribute("href") ?? ""
}

beforeEach(() => {
  localStorage.clear()
  stub()
})
afterEach(() => vi.restoreAllMocks())

describe("ChatsLinkRow", () => {
  it("points at the retained last stream", () => {
    setLastLocation(USER, WS, { surface: "board", streamId: "stream_9", board: { search: "" } })
    render(
      <MemoryRouter>
        <ChatsLinkRow workspaceId={WS} userId={USER} />
      </MemoryRouter>
    )
    expect(hrefOf("Chats")).toBe(`/w/${WS}/s/stream_9`)
  })

  it("falls back to the workspace home when no stream was retained", () => {
    render(
      <MemoryRouter>
        <ChatsLinkRow workspaceId={WS} userId={USER} />
      </MemoryRouter>
    )
    expect(hrefOf("Chats")).toBe(`/w/${WS}`)
  })
})

describe("BoardLinkRow", () => {
  it("falls back to the bare board route when no board state was retained", () => {
    render(
      <MemoryRouter>
        <BoardLinkRow workspaceId={WS} userId={USER} />
      </MemoryRouter>
    )
    expect(hrefOf("Board")).toBe(`/w/${WS}/board`)
  })
})
