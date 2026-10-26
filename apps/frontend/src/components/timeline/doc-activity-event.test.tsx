import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { StreamTypes, type DocActivityEventPayload, type StreamEvent } from "@threahq/types"
import * as hooksModule from "@/hooks"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { PanelProvider } from "@/contexts"
import { createMockStream } from "@/test/fixtures"
import { DocActivityEvent } from "./doc-activity-event"

const DOC = "stream_doc_1"
const NAMES: Record<string, string> = { usr_a: "Ann", usr_b: "Bo", usr_c: "Cy", usr_d: "Di" }

function activity(id: string, payload: Partial<DocActivityEventPayload>): StreamEvent {
  return {
    id,
    streamId: "stream_host",
    sequence: id.replace(/\D/g, "") || "1",
    eventType: "doc:activity",
    payload: {
      docId: DOC,
      actors: [],
      sections: [],
      removedBlockIds: [],
      editCount: 1,
      fromSequence: "1",
      toSequence: "2",
      ...payload,
    },
    actorId: null,
    actorType: "system",
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  } as StreamEvent
}

const users = (...ids: string[]) => ids.map((actorId) => ({ actorId, actorType: "user" as const }))
const section = (blockId: string, markdown: string) => ({ blockId, kind: "paragraph", markdown })

function renderRow(events: StreamEvent[]) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_host"]}>
      <PanelProvider>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<DocActivityEvent events={events} workspaceId="ws_1" />} />
        </Routes>
      </PanelProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: (id: string | null) => NAMES[id ?? ""] ?? "Someone",
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
    createMockStream({ id: DOC, type: StreamTypes.DOC, displayName: "Rotation tracker" }),
  ] as never)
})

afterEach(() => vi.restoreAllMocks())

describe("DocActivityEvent", () => {
  it("links to the doc pane and names distinct actors across the group", () => {
    renderRow([activity("e1", { actors: users("usr_a", "usr_b") }), activity("e2", { actors: users("usr_b") })])

    const link = screen.getByRole("link")
    expect({
      href: link.getAttribute("href"),
      docId: link.getAttribute("data-doc-id"),
      text: link.textContent,
    }).toEqual({
      href: "/w/ws_1/s/stream_doc_1?panel=stream_host-stream_doc_1",
      docId: DOC,
      text: expect.stringMatching(/^Ann and Bo edited Rotation tracker/),
    })
  })

  it("joins three names with a comma and collapses four into 'and 2 others'", () => {
    const { unmount } = renderRow([activity("e1", { actors: users("usr_a", "usr_b", "usr_c") })])
    expect(screen.getByRole("link")).toHaveTextContent("Ann, Bo and Cy edited")
    unmount()
    renderRow([activity("e1", { actors: users("usr_a", "usr_b", "usr_c", "usr_d") })])
    expect(screen.getByRole("link")).toHaveTextContent("Ann, Bo and 2 others edited")
  })

  it("strips markdown from section labels, truncates long ones, and counts the rest", () => {
    renderRow([
      activity("e1", {
        sections: [
          section("b1", "## **Goals**"),
          section("b2", "A very long paragraph that keeps on going well past the limit"),
          section("b3", "`code` here"),
        ],
      }),
      activity("e2", { sections: [section("b1", "## **Goals**"), section("b4", "Fourth"), section("b5", "Fifth")] }),
    ])
    expect(screen.getByRole("link")).toHaveTextContent(
      "· Goals, A very long paragraph that keeps on goin…, code here, +2 more"
    )
  })

  it("counts each removed block once across the group and drops its label", () => {
    const { unmount } = renderRow([activity("e1", { removedBlockIds: ["b9"] })])
    expect(screen.getByRole("link")).toHaveTextContent("edited Rotation tracker · 1 block removed")
    unmount()
    renderRow([
      activity("e1", { sections: [section("b1", "Goals"), section("b2", "Risks")], removedBlockIds: ["b8"] }),
      activity("e2", { removedBlockIds: ["b8", "b2"] }),
    ])
    expect(screen.getByRole("link")).toHaveTextContent("edited Rotation tracker · Goals · 2 blocks removed")
  })
})
