import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { StreamTypes, type StreamEvent } from "@threahq/types"
import * as hooksModule from "@/hooks"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { PanelProvider } from "@/contexts"
import { createMockStream } from "@/test/fixtures"
import { DocMovedEvent } from "./doc-moved-event"

const DOC = "stream_doc_1"

const event: StreamEvent = {
  id: "evt_moved",
  streamId: "stream_a",
  sequence: "9",
  broadcastSequence: "6",
  eventType: "doc:moved",
  payload: { docId: DOC, fromStreamId: "stream_a", toStreamId: "stream_b" },
  actorId: "usr_kris",
  actorType: "user",
  createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
}

function renderRow(hostId: string) {
  return render(
    <MemoryRouter initialEntries={[`/w/ws_1/s/${hostId}`]}>
      <PanelProvider>
        <Routes>
          <Route
            path="/w/:workspaceId/s/:streamId"
            element={<DocMovedEvent event={event} workspaceId="ws_1" streamId={hostId} />}
          />
        </Routes>
      </PanelProvider>
    </MemoryRouter>
  )
}

const doc = createMockStream({ id: DOC, type: StreamTypes.DOC, displayName: "Rotation tracker" })
const hostA = createMockStream({ id: "stream_a", type: StreamTypes.CHANNEL, slug: "alpha" })
const hostB = createMockStream({ id: "stream_b", type: StreamTypes.CHANNEL, slug: "bravo" })

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

describe("DocMovedEvent", () => {
  it("names the new host in the old host's timeline", () => {
    cacheStreams([doc, hostA, hostB])
    renderRow("stream_a")

    expect(screen.getByRole("link")).toHaveTextContent(/^Kris moved Rotation tracker to #bravo/)
  })

  it("names the old host in the new host's timeline", () => {
    cacheStreams([doc, hostA, hostB])
    renderRow("stream_b")

    expect(screen.getByRole("link")).toHaveTextContent(/^Kris moved Rotation tracker here from #alpha/)
  })

  it("renders without a link or names the viewer can no longer resolve", () => {
    cacheStreams([hostA])
    renderRow("stream_a")

    expect({ link: screen.queryByRole("link"), text: document.body.textContent }).toEqual({
      link: null,
      text: expect.stringMatching(/^Kris moved a doc to another stream/),
    })
  })
})
