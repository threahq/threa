import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { StreamTypes } from "@threahq/types"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as openAsideModule from "@/hooks/use-open-aside"
import { openAside, resetAsideStoreCache } from "@/stores/aside-store"
import { __resetAgentActivityStore, upsertAgentSession } from "@/stores/agent-activity-store"
import { createMockStream } from "@/test/fixtures"
import { AsideHeaderChip } from "./aside-header-chip"

const HOST = createMockStream({ id: "stream_host", type: StreamTypes.CHANNEL, rootStreamId: "stream_host" })
const older = createMockStream({
  id: "stream_aside_old",
  type: StreamTypes.ASIDE,
  displayName: "first thought",
  parentStreamId: "stream_host",
  createdAt: "2026-08-29T10:00:00.000Z",
})
const newer = createMockStream({
  id: "stream_aside_new",
  type: StreamTypes.ASIDE,
  displayName: "second thought",
  parentStreamId: "stream_host",
  createdAt: "2026-08-29T11:00:00.000Z",
})

function renderChip(stream = HOST) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_host"]}>
      <AsideHeaderChip workspaceId="ws_1" stream={stream as never} />
    </MemoryRouter>
  )
}

const chip = () => screen.getByTestId("aside-header-chip")

let openSpy: ReturnType<typeof vi.fn>
let resumeSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetAsideStoreCache()
  __resetAgentActivityStore()
  openSpy = vi.fn(() => Promise.resolve())
  resumeSpy = vi.fn()
  vi.spyOn(openAsideModule, "useOpenAside").mockReturnValue(openSpy as never)
  vi.spyOn(openAsideModule, "useResumeAside").mockReturnValue(resumeSpy as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue({ unreadCounts: {} } as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
})

afterEach(() => vi.restoreAllMocks())

describe("AsideHeaderChip", () => {
  it("opens a new aside on the stream when none exists", () => {
    renderChip()
    expect(chip()).toHaveAccessibleName("Open an aside")
    fireEvent.click(chip())
    expect(openSpy).toHaveBeenCalledWith({ kind: "stream", hostStreamId: "stream_host" })
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it("resumes the newest aside and carries the row's states", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([older, newer] as never)
    const view = renderChip()
    expect(chip()).toHaveAttribute("data-attention", "quiet")
    expect(chip()).toHaveAccessibleName("Resume aside: second thought")
    fireEvent.click(chip())
    expect(resumeSpy).toHaveBeenCalledWith({ hostStreamId: "stream_host", asideId: "stream_aside_new" })
    expect(openSpy).not.toHaveBeenCalled()

    vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue({
      unreadCounts: { stream_aside_new: 1 },
    } as never)
    view.rerender(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_host"]}>
        <AsideHeaderChip workspaceId="ws_1" stream={HOST as never} />
      </MemoryRouter>
    )
    expect(chip()).toHaveAttribute("data-attention", "new")
    expect(chip()).toHaveAccessibleName("Resume aside: second thought (new reply)")

    upsertAgentSession("ws_1", {
      sessionId: "sess_1",
      streamId: "stream_aside_new",
      rootStreamId: "stream_aside_new",
      personaName: "Ariadne",
      startedAt: new Date().toISOString(),
    })
    view.rerender(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_host"]}>
        <AsideHeaderChip workspaceId="ws_1" stream={HOST as never} />
      </MemoryRouter>
    )
    expect(chip()).toHaveAttribute("data-attention", "working")

    openAside({
      hostKey: "/w/ws_1/s/stream_host",
      hostStreamId: "stream_host",
      asideId: "stream_aside_new",
      originScope: "stream:stream_host",
    })
    view.rerender(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_host"]}>
        <AsideHeaderChip workspaceId="ws_1" stream={HOST as never} />
      </MemoryRouter>
    )
    expect(chip()).toHaveAttribute("data-attention", "open")
  })

  it("renders nothing where an aside cannot be opened and none exists", () => {
    renderChip(createMockStream({ id: "stream_host", type: StreamTypes.CHANNEL, e2eEnabled: true }) as never)
    expect(screen.queryByTestId("aside-header-chip")).toBeNull()
  })
})
