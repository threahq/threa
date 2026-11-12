import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DocSection, DocState, StreamWithPreview } from "@threahq/types"
import { render, screen } from "@/test"
import { docsApi } from "@/api/docs"
import { StreamHoverCard, type SidebarHoverIntent } from "./stream-hover-card"

const WS = "ws_1"
const DOC = { id: "stream_doc", type: "doc", displayName: "Rotation plan" } as StreamWithPreview

function section(position: number, kind: string, markdown: string): DocSection {
  return { blockId: `blk_${position}`, position, kind, markdown, contentJson: { type: "doc" } }
}

function renderCard() {
  const hover = { enabled: true, open: true, setOpen: vi.fn(), close: vi.fn() } as unknown as SidebarHoverIntent
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <StreamHoverCard hover={hover} workspaceId={WS} stream={DOC} unreadCount={0}>
          <button type="button">row</button>
        </StreamHoverCard>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("StreamHoverCard on a doc", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("should show the doc's sections in order, skipping blank ones", async () => {
    vi.spyOn(docsApi, "get").mockResolvedValue({
      sections: [
        section(0, "heading", "## Keys to rotate"),
        section(1, "paragraph", ""),
        section(2, "bulletList", "- Stripe\n- OpenRouter"),
      ],
    } as DocState)
    renderCard()

    expect(await screen.findByRole("heading", { name: "Keys to rotate" })).toBeInTheDocument()
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Stripe", "OpenRouter"])
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", `/w/${WS}/s/${DOC.id}`)
    expect(docsApi.get).toHaveBeenCalledWith(WS, DOC.id)
  })

  it("should say the doc is empty when it has no text", async () => {
    vi.spyOn(docsApi, "get").mockResolvedValue({ sections: [section(0, "paragraph", "  ")] } as DocState)
    renderCard()

    expect(await screen.findByText("Empty doc")).toBeInTheDocument()
  })
})
