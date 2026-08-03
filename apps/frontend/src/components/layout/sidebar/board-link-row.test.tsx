import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen } from "@/test"
import * as Contexts from "@/contexts"
import * as WorkspaceStore from "@/stores/workspace-store"
import { setLastLocation } from "@/lib/last-location"
import * as BoardViewHooks from "@/hooks/use-board-views"
import { BoardLinkRow, BoardUnreadRow, ChatsLinkRow } from "./board-link-row"

const WS = "workspace_1"
const USER = "user_1"

function stub() {
  vi.spyOn(Contexts, "useSidebar").mockReturnValue({
    collapseOnMobile: vi.fn(),
  } as unknown as ReturnType<typeof Contexts.useSidebar>)
  vi.spyOn(WorkspaceStore, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(BoardViewHooks, "useBoardViews").mockReturnValue({ data: [] } as never)
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

  it("carries no unread toggle — that's a board-mode filter, not a chats-mode row", () => {
    render(
      <MemoryRouter>
        <BoardLinkRow workspaceId={WS} userId={USER} />
      </MemoryRouter>
    )
    expect(screen.queryByText("Unread")).toBeNull()
  })
})

describe("BoardUnreadRow", () => {
  function renderAt(path: string, unreadStreamCount = 0) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <BoardUnreadRow workspaceId={WS} unreadStreamCount={unreadStreamCount} />
      </MemoryRouter>
    )
  }

  it("adds unread=true to the live board URL, preserving the other axes", () => {
    renderAt(`/w/${WS}/board?lens=mine&in=stream_1&panel=x`)
    expect(hrefOf("Unread")).toBe(`/w/${WS}/board?lens=mine&in=stream_1&panel=x&unread=true`)
  })

  it("drops exactly the unread param when it is already on", () => {
    renderAt(`/w/${WS}/board?lens=mine&unread=true&in=stream_1`)
    expect(hrefOf("Unread")).toBe(`/w/${WS}/board?lens=mine&in=stream_1`)
  })

  it("lands on the board home with unread=true from a non-board page", () => {
    renderAt(`/w/${WS}/s/stream_9`)
    expect(hrefOf("Unread")).toBe(`/w/${WS}/board?lens=all&unread=true`)
  })

  it("tracks the URL for its active state", () => {
    renderAt(`/w/${WS}/board?lens=all&unread=true`)
    expect(screen.getByRole("link", { name: "Unread" })).toHaveAttribute("aria-current", "true")
  })

  it("is not active off the board", () => {
    renderAt(`/w/${WS}/s/stream_9`)
    expect(screen.getByRole("link", { name: "Unread" })).not.toHaveAttribute("aria-current")
  })

  it("badges the unread stream count, and hides the badge at zero", () => {
    renderAt(`/w/${WS}/board?lens=all`, 4)
    expect(screen.getByRole("link", { name: /Unread/ })).toHaveTextContent("4")
  })

  it("renders no count at zero", () => {
    renderAt(`/w/${WS}/board?lens=all`, 0)
    expect(screen.getByRole("link", { name: "Unread" })).toHaveTextContent(/^Unread$/)
  })
})
