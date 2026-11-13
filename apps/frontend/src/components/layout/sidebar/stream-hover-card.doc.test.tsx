import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { QueryClientProvider, onlineManager } from "@tanstack/react-query"
import type { DocSection, DocState, StreamWithPreview } from "@threahq/types"
import { act, render, screen } from "@/test"
import { docsApi } from "@/api/docs"
import { makeQueryClient } from "@/contexts/query-client"
import { StreamHoverCard, type SidebarHoverIntent } from "./stream-hover-card"

const WS = "ws_1"
const DOC = { id: "stream_doc", type: "doc", displayName: "Rotation plan" } as StreamWithPreview

function section(position: number, kind: string, markdown: string): DocSection {
  return { blockId: `blk_${position}`, position, kind, markdown, contentJson: { type: "doc" } }
}

function renderCard() {
  const hover = { enabled: true, open: true, setOpen: vi.fn(), close: vi.fn() } as unknown as SidebarHoverIntent
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <StreamHoverCard hover={hover} workspaceId={WS} stream={DOC} unreadCount={0}>
          <button type="button">row</button>
        </StreamHoverCard>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function precedes(a: Element, b: Element): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe("StreamHoverCard on a doc", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    onlineManager.setOnline(true)
  })

  it("should show the doc's sections in order under the stream header, skipping blank ones", async () => {
    vi.spyOn(docsApi, "get").mockResolvedValue({
      sections: [
        section(0, "heading", "## Keys to rotate"),
        section(1, "paragraph", ""),
        section(2, "bulletList", "- Stripe\n- OpenRouter"),
      ],
    } as DocState)
    renderCard()

    const heading = await screen.findByRole("heading", { name: "Keys to rotate" })
    const items = screen.getAllByRole("listitem")
    expect({
      items: items.map((item) => item.textContent),
      headingFirst: precedes(heading, items[0]),
      openHref: screen.getByRole("link", { name: "Open" }).getAttribute("href"),
    }).toEqual({ items: ["Stripe", "OpenRouter"], headingFirst: true, openHref: `/w/${WS}/s/${DOC.id}` })
    expect(docsApi.get).toHaveBeenCalledWith(WS, DOC.id)
  })

  it("should say the doc is empty when it has no text", async () => {
    vi.spyOn(docsApi, "get").mockResolvedValue({ sections: [section(0, "paragraph", "  ")] } as DocState)
    renderCard()

    expect(await screen.findByText("Empty doc")).toBeInTheDocument()
  })

  it("should say the doc couldn't load while offline, and show it once the connection returns", async () => {
    onlineManager.setOnline(false)
    vi.spyOn(docsApi, "get")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ sections: [section(0, "paragraph", "Back online")] } as DocState)
    renderCard()

    expect(await screen.findByText("Couldn't load this doc")).toBeInTheDocument()
    act(() => onlineManager.setOnline(true))
    expect(await screen.findByText("Back online")).toBeInTheDocument()
  })
})
