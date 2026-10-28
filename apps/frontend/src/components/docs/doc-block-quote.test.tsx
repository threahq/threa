import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { DocErrorCodes } from "@threahq/types"
import { ApiError } from "@/api/client"
import { docsApi } from "@/api/docs"
import * as contextsModule from "@/contexts"
import * as streamNameModule from "@/hooks/use-stream-name"
import { DocBlockQuote } from "./doc-block-quote"

const DOC_ID = "stream_doc"
const BLOCK_ID = `blk_${"0".repeat(25)}1`

describe("DocBlockQuote", () => {
  beforeEach(() => {
    vi.spyOn(contextsModule, "usePanel").mockReturnValue({
      getPanelUrl: (panelId: string) => `/w/ws_1?panel=${panelId}`,
    } as unknown as ReturnType<typeof contextsModule.usePanel>)
    vi.spyOn(streamNameModule, "useStreamName").mockReturnValue("Rotation plan")
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function mount() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DocBlockQuote workspaceId="ws_1" docId={DOC_ID} blockId={BLOCK_ID} replyCount={2} />
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  it("should quote the block's markdown under a link to its doc", async () => {
    const getSection = vi.spyOn(docsApi, "getSection").mockResolvedValue({
      section: { blockId: BLOCK_ID, position: 0, kind: "paragraph", markdown: "Week **one** owners", contentJson: {} },
    })
    mount()

    const bold = await screen.findByText("one")
    expect({
      boldTag: bold.tagName,
      request: getSection.mock.calls[0],
      docLink: screen.getByRole("link", { name: "Rotation plan" }).getAttribute("href"),
    }).toEqual({ boldTag: "STRONG", request: ["ws_1", DOC_ID, BLOCK_ID], docLink: `/w/ws_1?panel=${DOC_ID}` })
  })

  it("should say the block was removed when its section is gone", async () => {
    vi.spyOn(docsApi, "getSection").mockRejectedValue(
      new ApiError(404, DocErrorCodes.SECTION_NOT_FOUND, "Section not found")
    )
    mount()

    const removed = await screen.findByText("This block was removed")
    expect({
      removed: removed.textContent,
      docLink: screen.getByRole("link", { name: "Rotation plan" }).getAttribute("href"),
    }).toEqual({ removed: "This block was removed", docLink: `/w/ws_1?panel=${DOC_ID}` })
  })
})
