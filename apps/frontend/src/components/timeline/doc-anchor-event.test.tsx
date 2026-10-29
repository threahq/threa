import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { StreamTypes, type StreamEvent } from "@threahq/types"
import * as hooksModule from "@/hooks"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { PanelProvider } from "@/contexts"
import { createMockStream } from "@/test/fixtures"
import { DocAnchorEvent } from "./doc-anchor-event"

const DOC = "stream_doc_1"

const event: StreamEvent = {
  id: "evt_doc",
  streamId: "stream_host",
  sequence: "7",
  broadcastSequence: "5",
  eventType: "doc:created",
  payload: { docId: DOC, createdBy: "usr_kris" },
  actorId: "usr_kris",
  actorType: "user",
  createdAt: new Date(Date.now() - 9 * 60_000).toISOString(),
}

function renderRow() {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_host"]}>
      <PanelProvider>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<DocAnchorEvent event={event} workspaceId="ws_1" />} />
        </Routes>
      </PanelProvider>
    </MemoryRouter>
  )
}

function cacheStreams(streams: ReturnType<typeof createMockStream>[]) {
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(streams as never)
}

beforeEach(() => {
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: (id: string | null) => (id === "usr_kris" ? "Kris" : "Someone"),
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
})

afterEach(() => vi.restoreAllMocks())

describe("DocAnchorEvent", () => {
  it("links the actor's row to the doc's pane, titled Untitled while the doc has no name", () => {
    cacheStreams([createMockStream({ id: DOC, type: StreamTypes.DOC, displayName: null })])
    renderRow()

    const link = screen.getByRole("link")
    expect({ href: link.getAttribute("href"), text: link.textContent }).toEqual({
      href: "/w/ws_1/s/stream_doc_1?panel=stream_host-stream_doc_1",
      text: expect.stringMatching(/^Kris created a docUntitled/),
    })
  })

  it("renders without a link or title when the viewer can no longer resolve the doc", () => {
    cacheStreams([])
    renderRow()

    expect({ link: screen.queryByRole("link"), text: document.body.textContent }).toEqual({
      link: null,
      text: expect.stringMatching(/^Kris created a doc\d/),
    })
  })

  it("links an uncached doc under an archived host, whose docs the bootstrap never lists", () => {
    cacheStreams([])
    const host = createMockStream({
      id: "stream_host",
      type: StreamTypes.CHANNEL,
      archivedAt: "2026-10-29T06:00:00.000Z",
    })
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamsSelect").mockImplementation((_ws, select) =>
      select([host] as never)
    )
    renderRow()

    expect(screen.getByRole("link").getAttribute("href")).toBe("/w/ws_1/s/stream_doc_1?panel=stream_host-stream_doc_1")
  })

  it("shows the doc's cached name", () => {
    cacheStreams([createMockStream({ id: DOC, type: StreamTypes.DOC, displayName: "Rotation tracker" })])
    renderRow()

    expect(screen.getByRole("link")).toHaveTextContent("Rotation tracker")
    expect(screen.getByRole("link")).not.toHaveTextContent("Untitled")
  })
})
