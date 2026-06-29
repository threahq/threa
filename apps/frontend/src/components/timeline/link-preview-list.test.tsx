import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { linkPreviewsApi } from "@/api"
import * as contextsModule from "@/contexts"
import { LinkPreviewList } from "./link-preview-list"
import type { LinkPreviewSummary } from "@threa/types"

function renderList(previews: LinkPreviewSummary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LinkPreviewList workspaceId="ws_123" messageId="msg_123" previews={previews} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const mockGetForMessage = vi.fn()
const mockDismiss = vi.fn()

describe("LinkPreviewList", () => {
  const preview: LinkPreviewSummary = {
    id: "preview_1",
    url: "https://example.com/article",
    title: "Preview title",
    description: "Preview description",
    imageUrl: null,
    faviconUrl: null,
    siteName: "Example",
    contentType: "website",
    position: 0,
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    mockGetForMessage.mockReset()
    mockDismiss.mockReset()
    mockDismiss.mockResolvedValue(undefined)

    vi.spyOn(linkPreviewsApi, "getForMessage").mockImplementation(
      (...args: Parameters<typeof linkPreviewsApi.getForMessage>) => mockGetForMessage(...args)
    )
    vi.spyOn(linkPreviewsApi, "dismiss").mockImplementation((...args: Parameters<typeof linkPreviewsApi.dismiss>) =>
      mockDismiss(...args)
    )
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { linkPreviewDefault: "open" },
    } as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(null as ReturnType<typeof contextsModule.useSocket>)
  })

  it("renders previews from the event payload without fetching per-message preview data", () => {
    render(<LinkPreviewList workspaceId="ws_123" messageId="msg_123" previews={[preview]} />)

    expect(screen.getByText("Preview title")).toBeInTheDocument()
    expect(mockGetForMessage).not.toHaveBeenCalled()
  })

  it("suppresses a stream_link card (it renders as an inline chip instead) but keeps web previews", () => {
    const streamPreview: LinkPreviewSummary = { ...preview, id: "p_stream", contentType: "stream_link" }
    renderList([streamPreview, preview])

    // The stream link has no card; the web preview in the same message still does.
    expect(screen.getByText("Preview title")).toBeInTheDocument()
  })

  it("keeps a message_link card — the inline chip is the body reference, the card is the preview below", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLink").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      deleted: true,
    })
    const messagePreview: LinkPreviewSummary = {
      ...preview,
      id: "p_msg",
      contentType: "message_link",
      url: "https://app.threa.io/w/ws_123/s/stream_1?m=msg_9",
    }
    renderList([messagePreview])

    await waitFor(() => expect(screen.getByText("This message was deleted")).toBeInTheDocument())
  })
})
